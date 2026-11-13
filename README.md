# Price Watch

A small local eBay watcher for a specific car speaker. Give it search terms and an item-price ceiling; it checks eBay's Browse API and prints a compact digest, optionally sending it to Discord. It alerts once per listing and again after the price falls at least 5% from the last alerted price.

The starter inquiry searches for **Hertz Cento Pro CPK 690** speaker sets with an item price strictly below **$400 USD**. Check that a listing includes the full set. Shipping and tax are not included in the ceiling. You can change the starter inquiry during setup and add other watches later. [Hertz product details](https://hertz-audio.com/product/cpk-690/).

## Try the demo

Install [Node.js 20 or newer](https://nodejs.org/) and run these commands from this folder:

```powershell
npm run demo
npm test
```

The demo uses invented listings, needs no account or network connection, sends no notifications, and does not save alert history.

## Set up live checks

1. Create an [eBay developer account and application](https://developer.ebay.com/). Obtain **production** client ID and client secret, and ensure your application has access to the [Browse API](https://developer.ebay.com/develop/api/buy/browse_api). Production Buy API access may require eBay approval; an API key alone may not grant it.
2. In PowerShell, set credentials for the current terminal session. Enter them at the prompts rather than putting them in a command or the repository:

   ```powershell
   $env:EBAY_CLIENT_ID = Read-Host 'eBay production client ID'
   $credential = Get-Credential -UserName $env:EBAY_CLIENT_ID -Message 'Enter the eBay production client secret as the password'
   $env:EBAY_CLIENT_SECRET = $credential.GetNetworkCredential().Password
   ```

3. Run `npm run setup` to create a product inquiry. Press Enter to use the starter product and price, or enter another name or listing link. Run setup again to add watches. Alternatively copy `config.example.json` to `config.json` and edit it manually. Give each additional watch a distinct, stable `id`.
4. Choose terminal or Discord alerts. For Discord setup, follow the [alert guide](ALERTS.md); the webhook must be set in the same terminal.
5. Run `npm start -- --once` for one check, or `npm start` to check repeatedly while the terminal is open. Stop with Ctrl+C. To use another configuration file, add `--config path/to/config.json`.

On the original development computer, `start-watcher.ps1` can also load an existing Windows-encrypted credential file outside this repository. Other users can use the environment-variable setup above; the repository does not include credentials.

Keep the computer awake and the process running for continuous monitoring. The default interval is 30 minutes; permitted values range from 5 to 1,440 minutes. Each check uses one search request per watch (up to 20 watches) plus authentication. Consider eBay's usage limits when choosing the interval. After failures, retry delays double up to 24 hours and return to normal after a successful check. Credentials are read from environment variables, not the configuration file. Windows environment variables set this way last only for that terminal session.

## Product inquiry and notifications

For step-by-step instructions, see the [alert setup guide](ALERTS.md), including Discord webhook setup and troubleshooting.

Setup accepts a product name or a full eBay item URL. For a URL, it looks up the listing title and suggests it as search text. Edit that text down to the brand, model and essential specifications: eBay treats space-separated terms as AND, so extra seller wording can hide useful results. Short links are not supported; open them in a browser and copy the full item URL. If lookup fails, enter a product name manually. Setup previews up to five current results under the ceiling, then asks before saving; a preview is not a guarantee of future matches.

Choose **terminal** or **Discord** alerts during setup. Discord needs a channel webhook in `DISCORD_WEBHOOK_URL` in the terminal where the watcher starts. The choice applies to all watches in that configuration. No alert is marked delivered if Discord is selected but its webhook is missing or delivery fails. The watcher must be running and online to send alerts; it does not yet support email, SMS, phone push notifications, or a hosted background service. Without Discord, terminal alerts are only visible in the running terminal.

## How matching works

- eBay searches the keywords and returns up to 200 of the newest results per watch. The watcher checks the returned item price is **strictly less than** `maxPrice`, in the configured currency. A listing at the exact ceiling is excluded.
- The ceiling applies to **item price only**, not shipping, tax, fees, or the final auction price. Shipping is shown when supplied by eBay, but may be unknown or vary by destination. Search defaults to eBay's fixed-price results; auction-only listings are not included.
- Keyword results can be unrelated, incomplete, or incorrectly described. This is not an AI verifier: open each listing to check the exact model, condition, fit, quantity, seller, and delivered cost. It does not purchase anything.
- eBay's search and result limits mean checks do not guarantee every listing is found. Prices and availability can change between checks.
- Each check sends at most one digest across all watches, showing up to five listings and a count of the rest. All results in a successfully delivered digest are recorded, including omitted results, to avoid follow-up spam; look on eBay for the rest. The first live run includes existing qualifying results. Further alerts require a price drop of at least 5% since that listing's last alert.
- Alert history is stored in `.price-watch-state.json` in the current working directory and capped at 10,000 entries. On the first run after upgrading, an existing `.speaker-watch-state.json` is renamed automatically if the new file does not already exist. If the cap is reached, the least recently observed entries are removed; an evicted listing may alert again if it reappears. Delete the file to reset all history. Changing a watch's query or threshold while retaining its `id` retains history; use a new `id` to treat it as a new watch. A Discord delivery failure leaves new results unrecorded for retry. With terminal alerts, terminal output counts as delivery. An interruption after delivery but before the history file is saved can cause a repeated digest.

`marketplace` and `currency` must match the eBay marketplace you use. The project is configured for US searches by default; it doesn't request a shipping destination. Run only one watcher instance per working directory to avoid conflicting state writes.

## Troubleshooting

- **401 or 403:** Check the production credentials and whether eBay has enabled Browse API access for the application.
- **429:** Increase the interval and check your eBay usage limits; failed checks retry with increasing delays.
- **No matches:** Verify the spelling and ceiling, try a broader query, and check the matching marketplace and currency.
- **Notifications missing:** Confirm the process is running and the webhook variable is set in that same terminal. Discord errors appear in the terminal and retry on the next check.

Built with Node's standard library. No dependencies or AI service are required. See [eBay's search documentation](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search) for API behavior and limitations.
