# Alert setup guide

Price Watch can show alerts in its terminal or send them to a Discord channel. Pick one during product inquiry setup; the choice applies to all watches in that configuration. Discord alerts also appear in the terminal. Both methods require the watcher to be running, the computer to be awake, and an internet connection. The program does not currently send email, SMS, or phone push notifications directly, and it is not a hosted service.

## Choose terminal alerts

1. Complete the product inquiry using the setup command in the [README](README.md). When asked how to receive notifications, choose **1. Terminal only** and save the inquiry.
2. Start the watcher using the continuous-run command in the README. Leave the terminal open. The first check summarizes current qualifying listings; later checks summarize new listings and price drops of at least 5% since the last alert.
3. Open a listing link to check the exact product, condition, shipping and total cost. Press Ctrl+C in the terminal when you want to stop watching.

If there are no qualifying results, you'll see a result count rather than an alert. Terminal alerts are only visible in that running terminal; closing it stops the watcher.

## Choose Discord alerts

1. In Discord, use a server and text channel where you have permission to manage webhooks. In **Server Settings > Integrations**, create a webhook, choose the channel, and copy its webhook URL. Discord's [webhook guide](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) has illustrated steps.
2. Treat the URL like a password: anyone who has it can post to that channel. Don't put it in the repository, screenshots, chat, or `config.json`. If it leaks, delete the webhook in Discord and create a new one.
3. In the PowerShell window you'll use to run Price Watch, run this command, then paste the URL when prompted and press Enter:

   ```powershell
   $env:DISCORD_WEBHOOK_URL = Read-Host 'Paste Discord webhook URL (visible on screen)'
   ```

   The pasted URL is visible on screen. This sets the variable for the current PowerShell session and processes started from it. It is lost when that window closes; set it again in a new window.
4. Run product inquiry setup, choose **2. Discord**, and save. To change an existing configuration without adding a product, open the ignored `config.json` and set `"notification": "discord"`. This setting applies to every watch.
5. Start the watcher **from the same PowerShell window**, using the command in the README. A qualifying listing should appear in the chosen Discord channel and in the terminal. Discord may also notify your phone or desktop according to your own Discord and device notification settings; Price Watch cannot control those settings.

Each check sends at most one digest across all watches, with up to five listing links and a count of any additional results. All qualifying listings in the digest are recorded even if their links were omitted; search on eBay to see the rest. The first run for a new watch includes current qualifying listings. If no listings qualify, there will be no Discord message. Switching an existing watch from terminal to Discord does not resend listings already recorded as alerted. A listing alerts again when its item price drops at least 5% from its last alerted price. Setup's preview does not send a Discord message.

## Change or troubleshoot alerts

- To switch back to terminal alerts, set `"notification": "terminal"` in `config.json`, then restart the watcher. Alternatively, choose the method while adding another inquiry; that changes the method for all watches.
- **No Discord message:** Check the watcher is running, there are qualifying results, the correct channel was selected, and `DISCORD_WEBHOOK_URL` is set in the same terminal. Avoid printing or sharing the URL while checking.
- **Discord error or missing webhook:** The terminal shows an error. Listings are not marked delivered, so the program retries after the problem is fixed. Retry intervals increase after repeated failures and return to normal after a successful check. A deleted or invalid webhook must be replaced.
- **No new terminal alert:** The listing may have already been recorded in `.price-watch-state.json`, or may be at or above the strict price ceiling. The ceiling is item price only, before shipping and tax.
- **Computer asleep or app closed:** Checks stop until the program is running again. It is not guaranteed to find listings that appear and disappear while it is offline.

The alert history file is stored in the current working directory. The Windows launcher uses the repository folder as its working directory. History is capped at 10,000 entries; evicted listings may alert again if seen later. Deleting the history resets alerts for every watch, causing qualifying results to be reported again on the next check. A crash after delivery but before the history file is saved can also cause a repeated digest.
