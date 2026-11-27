import { readFile, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

// ---------------------------------------------------------------------------
// Schemas: the shape of our data, written once with Valibot.
// The `v.description()` text is what the AI model reads, so keep it short and clear.
// ---------------------------------------------------------------------------

const OrderNumberSchema = v.pipe(
  v.string(),
  v.regex(
    /^ORD-\d{4}$/,
    'Order numbers look like ORD-1042: the letters ORD, a dash, then 4 digits.'
  ),
  v.description('Order number, for example ORD-1042.')
);

const EmailSchema = v.pipe(
  v.string(),
  v.email('That is not a valid email address.'),
  v.description('Customer email address, for example amara@example.com.')
);

const StatusSchema = v.pipe(
  v.picklist(['pending', 'packed', 'shipped', 'delivered']),
  v.description(
    'Order status. Only pending and packed orders can have their address changed.'
  )
);

const DateSchema = v.pipe(
  v.string(),
  v.isoDate('Dates must be written as YYYY-MM-DD, for example 2026-11-24.'),
  v.description('A date in YYYY-MM-DD format, for example 2026-11-24.')
);

// A required text field that must not be empty.
function requiredText(field: string, description: string) {
  return v.pipe(
    v.string(),
    v.nonEmpty(`The ${field} is missing. A full address needs a ${field}.`),
    v.description(description)
  );
}

// The second argument is the message used when a part of the address is missing.
const AddressSchema = v.object(
  {
    street: requiredText('street', 'House number and street name.'),
    city: requiredText('city', 'Town or city.'),
    postcode: requiredText('postcode', 'Postcode or ZIP code.'),
    country: requiredText('country', 'Country name, for example United Kingdom.'),
  },
  'The address is incomplete. A full address needs a street, city, postcode and country.'
);

const OrderSchema = v.object({
  orderNumber: OrderNumberSchema,
  customerName: v.pipe(v.string(), v.description('Customer full name.')),
  customerEmail: EmailSchema,
  status: StatusSchema,
  orderDate: v.pipe(DateSchema, v.description('Date the order was placed.')),
  items: v.pipe(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.description('Product name.')),
        quantity: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description('How many were bought.')
        ),
      })
    ),
    v.description('Products in the order.')
  ),
  deliveryAddress: AddressSchema,
});

type Order = v.InferOutput<typeof OrderSchema>;

// Tool results share this shape: a list of orders.
const OrderListOutputSchema = v.object({
  orders: v.pipe(v.array(OrderSchema), v.description('Matching orders.')),
});

// ---------------------------------------------------------------------------
// Data storage: orders.json. Replace these two functions to use a real database.
// ---------------------------------------------------------------------------

const DEFAULT_ORDERS_FILE = new URL('../orders.json', import.meta.url);

async function loadOrders(file: string | URL): Promise<Order[]> {
  const json: unknown = JSON.parse(await readFile(file, 'utf8'));
  return v.parse(v.array(OrderSchema), json);
}

async function saveOrders(file: string | URL, orders: Order[]): Promise<void> {
  await writeFile(file, JSON.stringify(orders, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Helpers for tool results
// ---------------------------------------------------------------------------

function describeOrder(order: Order): string {
  const items = order.items
    .map((item) => `${item.quantity} x ${item.name}`)
    .join(', ');
  const a = order.deliveryAddress;
  return [
    `${order.orderNumber} (${order.status}), placed ${order.orderDate}`,
    `  Customer: ${order.customerName} <${order.customerEmail}>`,
    `  Items: ${items}`,
    `  Deliver to: ${a.street}, ${a.city}, ${a.postcode}, ${a.country}`,
  ].join('\n');
}

// A failed tool call. The AI reads the message and can pass it on to the user.
function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Where orders are stored. Tests pass a temporary copy. */
  ordersFile?: string | URL;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const ordersFile = options.ordersFile ?? DEFAULT_ORDERS_FILE;
  const server = new McpServer({ name: 'shop-orders', version: '1.0.0' });

  // Tool 1: find-order -------------------------------------------------------
  server.registerTool(
    'find-order',
    {
      title: 'Find order',
      description:
        'Look up orders by order number or by customer email. Give one of the two.',
      inputSchema: toStandardJsonSchema(
        v.object({
          orderNumber: v.optional(OrderNumberSchema),
          customerEmail: v.optional(EmailSchema),
        })
      ),
      outputSchema: toStandardJsonSchema(OrderListOutputSchema),
      annotations: { readOnlyHint: true },
    },
    async ({ orderNumber, customerEmail }) => {
      if (!orderNumber && !customerEmail) {
        return toolError('Give an order number or a customer email to search for.');
      }
      const orders = await loadOrders(ordersFile);
      const matches = orders.filter(
        (order) =>
          (orderNumber && order.orderNumber === orderNumber) ||
          (customerEmail &&
            order.customerEmail.toLowerCase() === customerEmail.toLowerCase())
      );
      if (matches.length === 0) {
        return toolError(`No order found for ${orderNumber ?? customerEmail}.`);
      }
      return {
        content: [{ type: 'text', text: matches.map(describeOrder).join('\n\n') }],
        structuredContent: { orders: matches },
      };
    }
  );

  // Tool 2: change-delivery-address ------------------------------------------
  server.registerTool(
    'change-delivery-address',
    {
      title: 'Change delivery address',
      description:
        'Replace the delivery address of an order. Only works while the order is pending or packed. Needs the full new address.',
      inputSchema: toStandardJsonSchema(
        v.object(
          {
            orderNumber: OrderNumberSchema,
            newAddress: v.pipe(AddressSchema, v.description('The full new delivery address.')),
          },
          'Give both an order number and the full new address.'
        )
      ),
      outputSchema: toStandardJsonSchema(
        v.object({ order: v.pipe(OrderSchema, v.description('The updated order.')) })
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ orderNumber, newAddress }) => {
      const orders = await loadOrders(ordersFile);
      const order = orders.find((o) => o.orderNumber === orderNumber);
      if (!order) {
        return toolError(`No order found with number ${orderNumber}.`);
      }
      if (order.status === 'shipped' || order.status === 'delivered') {
        return toolError(
          `Order ${orderNumber} has already been ${order.status}, so its delivery address can no longer be changed.`
        );
      }
      order.deliveryAddress = newAddress;
      await saveOrders(ordersFile, orders);
      return {
        content: [
          { type: 'text', text: `Delivery address updated.\n\n${describeOrder(order)}` },
        ],
        structuredContent: { order },
      };
    }
  );

  // Tool 3: list-orders (optional, delete this line and the function below to remove it)
  registerListOrders(server, ordersFile);

  return server;
}

// ---------------------------------------------------------------------------
// Tool 3: list-orders. Self-contained so it is easy to delete.
// ---------------------------------------------------------------------------

function registerListOrders(server: McpServer, ordersFile: string | URL): void {
  server.registerTool(
    'list-orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first. Optionally filter by a date range and by status. Leave filters out to list everything.',
      inputSchema: toStandardJsonSchema(
        v.object({
          fromDate: v.optional(
            v.pipe(DateSchema, v.description('Earliest order date to include, YYYY-MM-DD.'))
          ),
          toDate: v.optional(
            v.pipe(DateSchema, v.description('Latest order date to include, YYYY-MM-DD.'))
          ),
          status: v.optional(StatusSchema),
        })
      ),
      outputSchema: toStandardJsonSchema(OrderListOutputSchema),
      annotations: { readOnlyHint: true },
    },
    async ({ fromDate, toDate, status }) => {
      const orders = await loadOrders(ordersFile);
      // YYYY-MM-DD dates sort correctly as plain text.
      const matches = orders
        .filter((o) => !fromDate || o.orderDate >= fromDate)
        .filter((o) => !toDate || o.orderDate <= toDate)
        .filter((o) => !status || o.status === status)
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
      const text =
        matches.length === 0
          ? 'No orders match those filters.'
          : `${matches.length} order(s), newest first:\n\n${matches.map(describeOrder).join('\n\n')}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { orders: matches },
      };
    }
  );
}
