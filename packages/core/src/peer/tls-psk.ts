import type { SecureVersion } from 'node:tls';

/** TLS-PSK parameters shared by the sharing server and client.
 *
 *  Pinned to TLS 1.2 with an ECDHE-PSK AEAD suite: this gives encryption,
 *  mutual authentication (a peer without the psk fails the handshake), and
 *  forward secrecy (the ECDHE keys are ephemeral). TLS 1.3 external PSK is
 *  intentionally avoided — Node's server-side support for it is unreliable. */
export const SHARING_TLS_MIN_VERSION: SecureVersion = 'TLSv1.2';
export const SHARING_TLS_MAX_VERSION: SecureVersion = 'TLSv1.2';
export const SHARING_TLS_CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305';

/** PSK identity advertised by the client. Routing only — the psk itself is
 *  what the TLS handshake actually verifies. */
export const SHARING_PSK_IDENTITY = 'costgoblin';
