# DONATION- — Saweria to Roblox Bridge

Node.js/Express bridge for forwarding Saweria donation notifications to a Roblox experience through Roblox Open Cloud MessagingService.

## Flow
Saweria webhook → Railway service → Roblox MessagingService topic → Roblox server script subscribes and displays the donation.

## 1. Deploy from GitHub to Railway
1. Create a Railway project and deploy this repository from GitHub.
2. Ensure the service uses the repository root and the start command `npm start`.
3. Generate a public domain in Railway.
4. Add the variables below in **Railway → Service → Variables**.

## 2. Required Railway variables
- `ROBLOX_API_KEY`: a newly generated Roblox Open Cloud API key. Grant only the required MessagingService publish permission for the target experience/universe.
- `UNIVERSE_ID`: Roblox **Universe ID**, not the Place ID.
- `SAWERIA_WEBHOOK_SECRET`: a long random secret used to protect the incoming webhook.
- `ADMIN_TOKEN`: a different long random secret for the dashboard test endpoint.
- `MESSAGING_TOPIC`: optional; defaults to `DonationNotif`.
- `PORT`: provided automatically by Railway; do not set unless needed.

**Security:** Never commit API keys or secrets. If a key was ever committed to a public repository, revoke/rotate it immediately. Environment variables do not erase old secrets from Git history.

## 3. Configure Saweria
Set the webhook/callback URL in the Saweria feature available to your account to:

```
https://YOUR-RAILWAY-DOMAIN/webhook/saweria?secret=YOUR_SAWERIA_WEBHOOK_SECRET
```

Use the exact secret stored as `SAWERIA_WEBHOOK_SECRET`. If Saweria's current webhook configuration uses a different authentication/signature scheme or payload format, adapt the callback configuration/normalizer accordingly. Do not share the secret URL publicly.

The bridge accepts common payload keys such as `donator_name`, `amount_raw`, `amount`, and `message`. It rejects requests with an invalid secret or non-positive amount.

## 4. Roblox setup
In Creator Dashboard, create/rotate the Open Cloud API key and grant the minimum MessagingService publish permission for the target universe. Put the key in Railway, not Roblox scripts. The experience's server-side Roblox script must subscribe to the same MessagingService topic (`DonationNotif`) and handle messages with fields `platform`, `donatorName`, `amount`, `message`, and `timestamp`.

Example server-side subscription pattern (adapt the display event to your existing UI):

```lua
local MessagingService = game:GetService("MessagingService")
local HttpService = game:GetService("HttpService")

local TOPIC = "DonationNotif"

local ok, err = pcall(function()
    MessagingService:SubscribeAsync(TOPIC, function(packet)
        local success, data = pcall(function()
            return HttpService:JSONDecode(packet.Data)
        end)
        if not success or type(data) ~= "table" then
            warn("Invalid donation message")
            return
        end

        local donor = tostring(data.donatorName or "Donatur Anonim")
        local amount = tonumber(data.amount) or 0
        local message = tostring(data.message or "")
        print(string.format("[DONATION] %s donated Rp %s: %s", donor, amount, message))

        -- Connect this validated event to your existing donation UI/RemoteEvent.
        -- Do not let clients grant currency/items based only on client-supplied values.
    end)
end)
if not ok then warn("SubscribeAsync failed:", err) end
```

MessagingService is for cross-server messages; each live server needs the subscription. Use pcall/retry logic in production and connect the callback to your existing server-authoritative donation UI.

## 5. Test
- Open `https://YOUR-RAILWAY-DOMAIN/health`. This reports whether required variables are present without exposing their values.
- Open the root dashboard, enter `ADMIN_TOKEN`, and send a test donation.
- Check Railway logs and the Roblox server output.
- Configure Saweria and make a small real test donation only after the test endpoint succeeds.

## Endpoints
- `GET /`: dashboard
- `GET /health`: health/configuration presence
- `GET /api/status`: service metadata
- `POST /webhook/saweria?secret=...`: Saweria callback
- `POST /api/test`: protected test; requires `x-admin-token`

## Important limitations
The bridge forwards notifications; it does not verify payment settlement independently and should not be used as the sole authority for awarding valuable in-game items. Validate webhook authentication and payload semantics against Saweria's current official integration options before production use.
