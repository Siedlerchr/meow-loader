import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { NetworkClient } from '../src/network';

describe('DNS pinning', () => {
  let server: Server;
  let port: number;
  const clients: NetworkClient[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://second.example:${port}/ok` });
        response.end();
        return;
      }

      response.writeHead(200);
      response.end(`ok ${request.headers.host ?? ''}`);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    port = address.port;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  });

  function createClient(options: ConstructorParameters<typeof NetworkClient>[0]): NetworkClient {
    const client = new NetworkClient(options);
    clients.push(client);
    return client;
  }

  it('connects to the validated address for a hostname that does not resolve normally', async () => {
    const client = createClient({
      playlistUrl: `http://pinned.example:${port}/`,
      allowPrivateNetwork: true,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    const response = await client.fetch(`http://pinned.example:${port}/`, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`ok pinned.example:${port}`);
  });

  it('re-pins each redirect target', async () => {
    let lookups = 0;
    const client = createClient({
      playlistUrl: `http://first.example:${port}/`,
      allowPrivateNetwork: true,
      dnsLookup: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });

    const response = await client.fetch(`http://first.example:${port}/redirect`, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`ok second.example:${port}`);
    expect(lookups).toBe(2);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    const client = createClient({
      playlistUrl: `http://private.example:${port}/`,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    await expect(client.fetch(`http://private.example:${port}/`, {})).rejects.toThrow(
      'loopback/private',
    );
  });

  it('caches validated addresses for the configured TTL', async () => {
    let lookups = 0;
    const client = createClient({
      playlistUrl: `http://cached.example:${port}/`,
      allowPrivateNetwork: true,
      dnsCacheTtlMs: 60_000,
      dnsLookup: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });

    await (await client.fetch(`http://cached.example:${port}/a`, {})).text();
    await (await client.fetch(`http://cached.example:${port}/b`, {})).text();

    expect(lookups).toBe(1);
  });
});
