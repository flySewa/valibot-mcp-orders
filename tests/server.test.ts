import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer } from '../src/server.ts';

// Each test gets a fresh copy of orders.json, so the real file is never changed.
let tempDir: string;
let ordersFile: string;
let client: Client;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'shop-orders-'));
  ordersFile = join(tempDir, 'orders.json');
  await copyFile(new URL('../orders.json', import.meta.url), ordersFile);

  // Connect a client and the server inside this process, with no network or stdio.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ ordersFile }).connect(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await rm(tempDir, { recursive: true, force: true });
});

// Pull the text message out of a tool result.
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join('\n');
}

const fullAddress = {
  street: '3 Canal Street',
  city: 'Manchester',
  postcode: 'M1 3HE',
  country: 'United Kingdom',
};

describe('tools/list', () => {
  test('lists the three tools and saves the response to tools-list.json', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual([
      'find-order',
      'change-delivery-address',
      'list-orders',
    ]);
    // Writes the file on the first run, then fails if the tools ever change.
    // Run `npx vitest run -u` to accept a change on purpose.
    await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(
      '../tools-list.json'
    );
  });
});

describe('find-order', () => {
  test('finds an order by order number', async () => {
    const result = await client.callTool({
      name: 'find-order',
      arguments: { orderNumber: 'ORD-1042' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      orders: [{ orderNumber: 'ORD-1042', customerName: 'Lucas Martin' }],
    });
    expect(textOf(result)).toContain('ORD-1042 (pending)');
  });

  test('finds every order for a customer email', async () => {
    const result = await client.callTool({
      name: 'find-order',
      arguments: { customerEmail: 'amara.okafor@example.com' },
    });
    const orders = (result.structuredContent as { orders: { orderNumber: string }[] }).orders;
    expect(orders.map((o) => o.orderNumber)).toEqual(['ORD-1041', 'ORD-1044']);
  });

  test('rejects a wrong order number format', async () => {
    const result = await client.callTool({
      name: 'find-order',
      arguments: { orderNumber: '1042' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Order numbers look like ORD-1042');
  });

  test('rejects a bad email', async () => {
    const result = await client.callTool({
      name: 'find-order',
      arguments: { customerEmail: 'amara.okafor-at-example' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not a valid email address');
  });

  test('asks for a search term when none is given', async () => {
    const result = await client.callTool({ name: 'find-order', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Give an order number or a customer email');
  });

  test('says clearly when no order exists', async () => {
    const result = await client.callTool({
      name: 'find-order',
      arguments: { orderNumber: 'ORD-9999' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No order found for ORD-9999');
  });
});

describe('change-delivery-address', () => {
  test('changes the address of a pending order and saves it to the file', async () => {
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: { orderNumber: 'ORD-1042', newAddress: fullAddress },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      order: { orderNumber: 'ORD-1042', deliveryAddress: fullAddress },
    });

    const saved = JSON.parse(await readFile(ordersFile, 'utf8'));
    const order = saved.find((o: { orderNumber: string }) => o.orderNumber === 'ORD-1042');
    expect(order.deliveryAddress).toEqual(fullAddress);
  });

  test('rejects an incomplete address', async () => {
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: {
        orderNumber: 'ORD-1042',
        newAddress: { street: '3 Canal Street', city: 'Manchester', country: 'United Kingdom' },
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('newAddress.postcode: The address is incomplete.');
  });

  test('rejects a missing address', async () => {
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: { orderNumber: 'ORD-1042' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Give both an order number and the full new address.');
  });

  test('rejects an empty address field', async () => {
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: { orderNumber: 'ORD-1042', newAddress: { ...fullAddress, city: '' } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The city is missing');
  });

  test('refuses to change a shipped order, and leaves the file alone', async () => {
    const before = await readFile(ordersFile, 'utf8');
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: { orderNumber: 'ORD-1043', newAddress: fullAddress },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Order ORD-1043 has already been shipped, so its delivery address can no longer be changed.'
    );
    expect(await readFile(ordersFile, 'utf8')).toBe(before);
  });

  test('refuses to change a delivered order', async () => {
    const result = await client.callTool({
      name: 'change-delivery-address',
      arguments: { orderNumber: 'ORD-1041', newAddress: fullAddress },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('already been delivered');
  });
});

describe('list-orders', () => {
  test('lists orders in a date range, newest first', async () => {
    const result = await client.callTool({
      name: 'list-orders',
      arguments: { fromDate: '2026-11-15', toDate: '2026-11-22' },
    });
    const orders = (result.structuredContent as { orders: { orderNumber: string }[] }).orders;
    expect(orders.map((o) => o.orderNumber)).toEqual(['ORD-1044', 'ORD-1048', 'ORD-1043', 'ORD-1047']);
  });

  test('filters by status', async () => {
    const result = await client.callTool({
      name: 'list-orders',
      arguments: { status: 'pending' },
    });
    const orders = (result.structuredContent as { orders: { orderNumber: string }[] }).orders;
    expect(orders.map((o) => o.orderNumber)).toEqual(['ORD-1050', 'ORD-1046', 'ORD-1042']);
  });

  test('rejects a badly written date', async () => {
    const result = await client.callTool({
      name: 'list-orders',
      arguments: { fromDate: '24/11/2026' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('YYYY-MM-DD');
  });
});
