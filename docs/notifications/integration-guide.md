# Notifications: integration guide for the apps

_For developers of the customer app (Android / iOS / web), admin panel, warehouse panel and
logistics app._ Every call goes through the gateway (`https://<api>/v1/...`) with the user's
access token (`Authorization: Bearer <token>`). Full request / response schemas: Swagger at
`/api-docs` (tags _Notifications_, _Notification Preferences_, _Notification Devices_, _Admin
Notifications_, _Admin Notification Templates_).

## 1. Which inbox (`app`)

Each app has its own inbox. Pass `app` (query, or body for writes); it is checked against the
signed-in account type, so an app can never read another app's inbox.

| App                    | `app`                              | Account type      |
| ---------------------- | ---------------------------------- | ----------------- |
| Customer app / web     | `CUSTOMER` (default for customers) | CUSTOMER          |
| Admin panel            | `ADMIN` (default for staff)        | INTERNAL          |
| Warehouse panel        | `WAREHOUSE`                        | INTERNAL          |
| Logistics / driver app | `LOGISTICS` (default)              | LOGISTICS_PARTNER |
| Vendor portal (future) | `VENDOR` (default)                 | VENDOR            |

A wrong `app` for the account → **403**. Another user's notification id → **404**.

## 2. Inbox screen

```http
GET /v1/notifications?app=CUSTOMER&limit=20
GET /v1/notifications?app=CUSTOMER&limit=20&cursor=<meta.nextCursor>
GET /v1/notifications?app=CUSTOMER&unread=true&category=ORDER
```

```json
{
  "success": true,
  "data": [
    {
      "id": "0193a5f2-…",
      "category": "ORDER",
      "priority": "NORMAL",
      "title": "Order ORD-26-0091842 confirmed",
      "body": "Your order ORD-26-0091842 is confirmed and is being prepared.",
      "data": { "entityType": "order", "entityId": "0193a5f2-…", "orderNo": "ORD-26-0091842" },
      "read": false,
      "readAt": null,
      "createdAt": "2026-11-24T10:15:00.000Z"
    }
  ],
  "meta": { "nextCursor": "0193a5f2-…", "limit": 20 }
}
```

- Newest first. Keep requesting with `cursor = meta.nextCursor` until it is `null`; pages stay
  stable while new notifications arrive.
- **Deep link:** open the screen for `data.entityType` + `data.entityId`:

  | `entityType`          | Open                                                                |
  | --------------------- | ------------------------------------------------------------------- |
  | `order`               | Order detail (`entityId` = order id)                                |
  | `refund`              | Refund detail (admin)                                               |
  | `variant`             | Product / stock screen (`data.warehouseId` for the warehouse panel) |
  | `offer` (admin sends) | Offer / campaign page (`entityId` = your offer code)                |

  Unknown types: just show the notification.

- Badge: `GET /v1/notifications/unread-count?app=CUSTOMER` → `{ "unreadCount": 3 }`.
- Tap an item: `POST /v1/notifications/{id}/read?app=CUSTOMER` → `{ id, read: true, unreadCount }`
  (idempotent; update the badge from the response).
- "Mark all as read": `POST /v1/notifications/read-all` with
  `{ "app": "CUSTOMER", "before": "<createdAt of the newest item shown>" }` so items that arrive
  meanwhile stay unread.

## 3. Live updates (SSE)

`GET /v1/notifications/stream?app=CUSTOMER` returns `text/event-stream`. Browsers' native
`EventSource` cannot send the `Authorization` header, so use `fetch` (web) or an SSE client that
supports headers (Android: OkHttp SSE; iOS: URLSession bytes / LDSwiftEventSource).

```ts
const res = await fetch(`${API}/v1/notifications/stream?app=CUSTOMER`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
// Split on blank lines; each frame has `event: <name>` and `data: <json>` lines.
```

| Event          | Data                           | Do                                                         |
| -------------- | ------------------------------ | ---------------------------------------------------------- |
| `unread_count` | `{ unreadCount }`              | Set the badge (first frame, and after reads on any device) |
| `notification` | an inbox item (as in the list) | Prepend to the list, badge + 1, optional toast             |
| `reauth`       | `{}`                           | The token expires in ~30 s: refresh it, reconnect          |

- `: ping` comment frames every 25 s keep proxies open; ignore them.
- On disconnect, reconnect after ~5 s with backoff, then **re-read the unread count / first
  page**: live events are best effort, the inbox is the source of truth.
- At most 5 open streams per user (the 6th → 429). Open one per app instance, close it when the
  app goes to the background (mobile: rely on push then).

## 4. Push notifications (FCM)

1. Add Firebase to the app (Android, iOS via APNs key in Firebase, web via VAPID key) and get
   the FCM registration token.
2. After sign-in, and whenever Firebase rotates the token (`onNewToken` / `messaging:didReceiveRegistrationToken`):

   ```http
   POST /v1/notifications/devices
   { "token": "<fcm token>", "platform": "ANDROID", "app": "CUSTOMER", "deviceId": "<install id>" }
   ```

   Returns the device `id` (store it). The token is never returned. A token signed in on another
   account moves to that account. Max 10 devices per user.

3. On sign-out: `DELETE /v1/notifications/devices/{id}` **before** discarding the access token.
4. Push payload: `notification.title` / `notification.body` (shown by the OS) and `data`:

   ```json
   {
     "notificationId": "0193a5f2-…",
     "app": "CUSTOMER",
     "entityType": "order",
     "entityId": "0193a5f2-…",
     "orderNo": "ORD-26-0091842"
   }
   ```

   On tap: deep link (section 2) and `POST /v1/notifications/{notificationId}/read`. Delivery is
   at-least-once: if the same `notificationId` arrives twice, show it once.

## 5. Notification settings screen

```http
GET /v1/notifications/preferences
PUT /v1/notifications/preferences
{ "changes": [ { "category": "ORDER", "channel": "EMAIL", "enabled": false } ] }
```

`GET` returns one row per category: `{ category, mandatory, push, email, sms }`. Render a toggle
per channel; rows with `mandatory: true` (SECURITY) are read-only. Send only what changed; the
response is the full matrix. In-app notifications cannot be turned off. PROMO is off until the
user turns it on. Say in the UI that SMS is used only for important updates, and that email / SMS
go to the **verified** email / phone of the account.

## 6. Admin panel

Permissions: `notifications.view` (read) and `notifications.manage` (write). Every write needs a
`reason` (≥ 10 characters) and is audited.

**Compose screen** → `POST /v1/admin/notifications` with a fresh `Idempotency-Key` header per
compose (reuse it on retry: the first result comes back, nothing is sent twice).

```json
{
  "app": "CUSTOMER",
  "category": "PROMO",
  "priority": "NORMAL",
  "audience": { "type": "APP" },
  "channels": ["PUSH"],
  "templateKey": "admin.message",
  "vars": { "title": "Diwali offers", "body": "Up to 15% off on vaccines till 5 Nov." },
  "data": { "entityType": "offer", "entityId": "DIWALI26" },
  "scheduledFor": "2026-11-01T03:30:00.000Z",
  "expiresAt": "2026-11-06T00:00:00.000Z",
  "reason": "Diwali campaign approved by marketing"
}
```

| Audience                                                                       | Use                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `{ "type": "USER", "userIds": [id] }` / `USERS` (≤ 1000)                       | Specific people                                           |
| `{ "type": "PERMISSION", "permission": "inventory.view", "warehouseId": "…" }` | Staff of a role / warehouse (ADMIN or WAREHOUSE app only) |
| `{ "type": "APP" }`                                                            | Everyone on that app (broadcast)                          |

Not available to staff: category `SECURITY`, priority `CRITICAL`.

**History** `GET /v1/admin/notifications?source=admin&status=…` · **detail** with delivery
counts `GET /{id}` · **cancel** a scheduled or in-progress send `POST /{id}/cancel`.

**Failed deliveries** `GET /v1/admin/notifications/deliveries?status=FAILED` → retry one
`POST /deliveries/{id}/retry` or many `POST /deliveries/retry-failed` (`{ channel, notificationId?, reason }`).

**Templates** `GET /v1/admin/notification-templates?active=true` → edit = `POST /{id}/versions`
(`activate: false` for a draft) → `POST /{id}/preview` with sample `vars` → `POST /{id}/activate`.
Roll back by activating an older version.

**Analytics** `GET /v1/admin/notifications/analytics?from&to` (≤ 92 days): created per category,
per channel sent / failed / skipped / in flight, success rate, average latency.

## 7. Warehouse panel and logistics app

- Warehouse panel: use `app=WAREHOUSE` for the inbox, stream and device registration. Low-stock
  alerts arrive here for staff holding `inventory.view` globally or for that warehouse
  (`data.warehouseId`, `data.entityId` = variant id).
- Logistics app: `app=LOGISTICS`. Shipment / delivery events are not published yet (logistics
  service F1); the inbox, push registration and admin sends to `LOGISTICS` users work today.

## Errors

Envelope `{ success: false, error: { code, message, details?, requestId } }`. 401 token missing /
expired; 403 wrong app or missing permission; 404 not yours / unknown; 409 state conflict
(cancel / retry); 422 validation with `details.issues[{ path, message }]`; 429 rate limit
(`retry-after` header).
