import { finalizeEvent, nip04, nip44, getPublicKey } from "nostr-tools";
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { hexToBytes } from "nostr-tools/utils";
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket)

const config = {
  privateKey: '8b5ba3be4b1a801d843c726a015b3c69b9bb32b2ffaf945d3d3384c2ea68f99a',
  bunkerSecret: 'devsecret123',
  relays: [
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://relay.nsec.app'
  ]
}

const sk = hexToBytes(config.privateKey);
const publicKey = getPublicKey(sk);
const pool = new SimplePool();

pool.subscribeMany(
  config.relays,
  [
    {
      kinds: [24133],
      '#p': [publicKey],
      since: Math.floor(Date.now() / 1000)
    }
  ],
  {
    onevent: async (event) => {
      if (event.pubkey == publicKey) return;

      let decrypted;
      let useNip44 = false;
      try {
        // Try NIP-44 first
        const conversationKey = nip44.getConversationKey(sk, event.pubkey);
        decrypted = nip44.decrypt(event.content, conversationKey);
        useNip44 = true;
      } catch (e) {
        // Fallback to NIP-04
        try {
          decrypted = nip04.decrypt(sk, event.pubkey, event.content);
        } catch (e2) {
          return;
        }
      }

      try {
        const request = JSON.parse(decrypted);

        // Handle the request
        let response = { id: request.id, result: null, error: null };

        try {
          switch (request.method) {
            case 'connect':
              if (request.params && request.params[1] !== config.bunkerSecret) {
                throw new Error('Invalid secret');
              }
              response.result = 'ack';
              break;

            case 'ping':
              response.result = 'pong';
              break;

            case 'get_public_key':
              response.result = publicKey;
              break;

            case 'sign_event':
              if (!request.params || !request.params[0]) {
                throw new Error('Event required');
              }
              // Parse if client sends JSON string instead of object
              let eventToSign = request.params[0];
              if (typeof eventToSign === 'string') {
                eventToSign = JSON.parse(eventToSign);
              }
              // Add pubkey to the event
              eventToSign.pubkey = publicKey;
              const signedEvent = finalizeEvent(eventToSign, sk);
              response.result = JSON.stringify(signedEvent);  // NIP-46 requires JSON string
              break;

            case 'get_relays':
              response.result = JSON.stringify({});
              break;

            case 'nip04_encrypt':
              response.result = nip04.encrypt(sk, request.params[0], request.params[1]);
              break;

            case 'nip04_decrypt':
              response.result = nip04.decrypt(sk, request.params[0], request.params[1]);
              break;

            case 'nip44_encrypt':
              const encKey = nip44.getConversationKey(sk, request.params[0]);
              response.result = nip44.encrypt(request.params[1], encKey);
              break;

            case 'nip44_decrypt':
              const decKey = nip44.getConversationKey(sk, request.params[0]);
              response.result = nip44.decrypt(request.params[1], decKey);
              break;

            default:
              throw new Error(`Unknown method: ${request.method}`);
          }
        } catch (e) {
          response.error = e.message;
          response.result = null;
        }

        // Send response back using the same encryption method
        let responseContent;
        if (useNip44) {
          const conversationKey = nip44.getConversationKey(sk, event.pubkey);
          responseContent = nip44.encrypt(JSON.stringify(response), conversationKey);
        } else {
          responseContent = nip04.encrypt(sk, event.pubkey, JSON.stringify(response));
        }

        const responseEvent = {
          kind: 24133,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', event.pubkey],
            ['e', event.id]
          ],
          content: responseContent
        };

        const signed = finalizeEvent(responseEvent, sk);
        await Promise.allSettled(pool.publish(config.relays, signed));
      } catch (e) {
        console.error('Failed to parse:', e.message);
      }
    }
  }
);
