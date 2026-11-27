# valibot-mcp-orders

A small [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for a made-up online shop. It lets an AI app such as Claude Desktop or Cursor look up orders and change delivery addresses.

It is the example project for the tutorial **"How to Build a TypeScript MCP Server with Valibot."** The whole server lives in two files:

| File            | What it does                                              |
| --------------- | --------------------------------------------------------- |
| `src/server.ts` | The Valibot schemas, the three tools, and reading/saving orders |
| `src/index.ts`  | Starts the server over stdio                              |

## Versions used

Every package is pinned to an exact version in `package.json`.

| Tool                           | Version |
| ------------------------------ | ------- |
| Node.js                        | 26.13.1 (LTS). Tests also pass on 22.23.5. |
| npm                            | 11.20.0 |
| `@modelcontextprotocol/server` | 2.4.0   |
| `valibot`                      | 1.5.0   |
| `@valibot/to-json-schema`      | 1.8.0   |
| `typescript`                   | 7.0.2   |
| `vitest`                       | 5.1.2   |
| `@modelcontextprotocol/client` | 2.4.0 (tests only) |
| `@types/node`                  | 26.6.11 |
| `@modelcontextprotocol/inspector` | 2.17.0 (run with `npx`, not installed) |

## Quick start

```bash
npm install
npm run build   # compiles src/ into dist/
npm test        # runs the automated tests
```

`npm start` runs the server, but on its own it just waits for an AI app to talk to it. Use the Inspector or an AI app (below) to try it.

## The tools

| Tool                      | What it does |
| ------------------------- | ------------ |
| `find-order`              | Finds orders by order number (like `ORD-1042`) or by customer email. |
| `change-delivery-address` | Replaces the delivery address. Needs the full address. Refuses orders that are already shipped or delivered. Saves the change to `orders.json`. |
| `list-orders`             | Lists orders, newest first, with an optional date range and status filter. |

Each tool returns readable text for the AI plus `structuredContent` that matches its `outputSchema`. The full `tools/list` response, including every schema the AI sees, is saved in [`tools-list.json`](./tools-list.json).

Sample data lives in `orders.json`: 10 orders. ORD-1042, ORD-1046 and ORD-1050 are pending, and ORD-1044 and ORD-1048 are packed, so their addresses can be changed. ORD-1043, ORD-1047 and ORD-1049 are shipped, and ORD-1041 and ORD-1045 are delivered, so they can't.

### Removing `list-orders`

`list-orders` is self-contained. To remove it, delete the `registerListOrders(server, ordersFile);` line and the `registerListOrders` function at the bottom of `src/server.ts`, then delete the `list-orders` tests in `tests/server.test.ts` and run `npx vitest run -u` to update `tools-list.json`.

## Test with the MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the official tool for trying out an MCP server by hand.

```bash
npm run build
npx @modelcontextprotocol/inspector@2.17.0 node dist/index.js
```

It prints an address like `http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=...` and opens it in your browser. Click **Connect**, open **Tools**, click **List Tools**, then pick a tool, fill in the fields and click **Run Tool**.

For a quick check without the browser, use the Inspector's command-line mode:

```bash
npx @modelcontextprotocol/inspector@2.17.0 --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector@2.17.0 --cli node dist/index.js --method tools/call --tool-name find-order --tool-arg orderNumber=ORD-1042
```

## Connect to Claude Desktop

1. Run `npm run build`.
2. Open **Settings** from the **Claude** menu in your computer's top menu bar (not the settings inside the chat window), then go to **Developer → Edit Config**. This opens `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add the server, using the **full path** to `dist/index.js` on your computer:

   ```json
   {
     "mcpServers": {
       "shop-orders": {
         "command": "node",
         "args": ["/full/path/to/valibot-mcp-orders/dist/index.js"]
       }
     }
   }
   ```

   On Windows, write the path with double backslashes, for example `"C:\\Users\\you\\valibot-mcp-orders\\dist\\index.js"`.
4. Quit Claude Desktop completely and open it again.
5. Click the **Add files, connectors and more** button at the bottom left of the message box. Check that `shop-orders` is listed with its three tools.
6. Ask: *"What's the status of order ORD-1042?"* Claude asks for your approval before it uses a tool for the first time.

If the server doesn't appear, Claude Desktop may be finding a different Node version than the one you installed (common with nvm). Replace `"node"` with the full path that `which node` (macOS) or `where node` (Windows) prints.

## Connect to Cursor

> These steps were checked against Cursor's docs (<https://cursor.com/docs/context/mcp>) but haven't been tested in Cursor itself.

1. Run `npm run build`.
2. Create `.cursor/mcp.json` in your project (for one project) or `~/.cursor/mcp.json` (for every project).
3. Add the server. Cursor's docs list `"type": "stdio"` as required:

   ```json
   {
     "mcpServers": {
       "shop-orders": {
         "type": "stdio",
         "command": "node",
         "args": ["/full/path/to/valibot-mcp-orders/dist/index.js"]
       }
     }
   }
   ```

4. Open Cursor's **Customize** page, where MCP servers are managed. Check that `shop-orders` is turned on and lists three tools.
5. In the chat, ask: *"Find all orders for amara.okafor@example.com."*

## Replacing orders.json with a real database

All storage goes through two functions near the top of `src/server.ts`:

```ts
async function loadOrders(file: string | URL): Promise<Order[]> { ... }
async function saveOrders(file: string | URL, orders: Order[]): Promise<void> { ... }
```

These are the only places that touch `orders.json`. To use a real database:

1. Replace `loadOrders` with a database query. Keep the `v.parse(v.array(OrderSchema), rows)` line, so bad rows from the database are caught before they reach the AI.
2. Replace `saveOrders` with an update query. With a database you would update one order instead of rewriting them all. For example, add an `updateDeliveryAddress(orderNumber, address)` function and call it from `change-delivery-address`.
3. Move filtering into the database. `find-order` and `list-orders` currently load every order and filter in JavaScript. With real data, put the order number, email, date range and status into the query's `WHERE` clause and the sort into `ORDER BY orderDate DESC`.
4. Replace the `ordersFile` option in `createServer` with your database connection, so tests can still pass in a test database.
5. Do the "already shipped?" check and the update in one step (for example `UPDATE ... WHERE status IN ('pending', 'packed')`). Otherwise an order could ship between the check and the save.

The tool schemas, descriptions and messages stay the same.

## Project files

| File                   | Purpose |
| ---------------------- | ------- |
| `src/server.ts`        | Schemas, tools and storage |
| `src/index.ts`         | stdio entry point |
| `tests/server.test.ts` | Automated tests using an in-memory client |
| `orders.json`          | Sample data |
| `tools-list.json`      | Saved `tools/list` response |
| `LICENSE`              | MIT license |

## License

[MIT](./LICENSE) © 2026 Oluwawunmi Bewaji
