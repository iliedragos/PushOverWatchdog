# Notification integrations: Pushover, Telegram and Zabbix

This page explains how to connect **Pushover Watchdog** to Pushover, Telegram and Zabbix in FM-DX Webserver.

The instructions below apply to **Pushover Watchdog v1.0.1**. Each notification channel can be enabled or disabled independently, so you can use one service, two of them, or all three at the same time.

## What the plugin sends

When enabled, the plugin can send alerts for:

* signal below the configured threshold / probable white noise;
* blank audio or missing modulation;
* missing valid RDS identity;
* unstable or lost stereo indication;
* recovery, when recovery notifications are enabled.

A test message can be sent for each channel from the **FM Monitor** administration panel.

## Where the settings are stored

The plugin configuration file is:

```text
plugins_configs/PushoverWatchdog.json
```

After changing the file, the plugin reloads it automatically. A full FM-DX Webserver restart is normally not required for configuration changes, although a restart is recommended after installing or replacing plugin files.

### Important note about secrets

For security reasons, the current plugin does **not** send Pushover or Telegram secrets through the browser panel. These values must be entered directly in `plugins_configs/PushoverWatchdog.json`:

```json
{
  "pushoverUserKey": "YOUR_PUSHOVER_USER_KEY",
  "pushoverApiToken": "YOUR_PUSHOVER_API_TOKEN",
  "telegramBotToken": "YOUR_TELEGRAM_BOT_TOKEN"
}
```

The panel will show whether the credentials are configured, but it will not display their contents. Do not commit a configuration file containing real tokens to a public GitHub repository.

---

# Pushover

Pushover is the simplest option for direct push notifications to a phone or desktop. The plugin sends messages through the Pushover Message API using your **User Key** and an **Application API Token**.

## Requirements

You need:

1. a Pushover account;
2. the Pushover app installed and activated on at least one receiving device;
3. your Pushover **User Key**;
4. an application created for FM-DX / Pushover Watchdog, which provides its **API Token**.

## Create a Pushover application and obtain the API token

1. Sign in to your Pushover account at [pushover.net](https://pushover.net/).
2. On the dashboard, locate your **User Key** and keep it for the plugin configuration.
3. Under **Your Applications**, create a new application/API token.
4. Give the application a useful name, for example `FM-DX Watchdog` or `FM-DX Webserver`.
5. Optionally upload an icon so alerts are easy to recognize on your device.
6. Once the application is created, copy its **API Token/Key**.

The User Key identifies who receives the message. The Application API Token identifies the application sending it. Both are required.

Official API documentation: [Pushover Message API](https://pushover.net/api)

## Configure Pushover Watchdog

Open `plugins_configs/PushoverWatchdog.json` and add your credentials:

```json
{
  "pushoverEnabled": true,
  "pushoverUserKey": "YOUR_PUSHOVER_USER_KEY",
  "pushoverApiToken": "YOUR_PUSHOVER_API_TOKEN",
  "pushoverDevice": "",
  "pushoverSound": "pushover",
  "pushoverPriority": 0,
  "pushoverRetrySeconds": 60,
  "pushoverExpireSeconds": 1800
}
```

Then open **FM Monitor** in the administration interface and check **Enable Pushover notifications**.

## Pushover settings in the panel

| Setting                           | Purpose                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Enable Pushover notifications** | Turns Pushover delivery on or off without affecting Telegram or Zabbix.                                                                |
| **Device**                        | Optional. Leave blank to notify all devices registered to your Pushover account. Enter a device name to restrict alerts to one device. |
| **Sound**                         | Optional Pushover sound name. The default in the plugin is `pushover`.                                                                 |
| **Priority**                      | Message priority from `-2` to `2`. For normal monitoring, `0` is a sensible starting point.                                            |
| **Emergency retry seconds**       | Used only when priority is `2`. Minimum accepted by Pushover is 30 seconds.                                                            |
| **Emergency expire seconds**      | Used only when priority is `2`. Determines how long Pushover continues repeating the alert.                                            |

## About emergency priority

Priority `2` is intended for situations where an alert must keep repeating until acknowledged. When this priority is used, the plugin sends both `retry` and `expire` values, as required by Pushover.

A practical example is:

```json
{
  "pushoverPriority": 2,
  "pushoverRetrySeconds": 60,
  "pushoverExpireSeconds": 1800
}
```

This requests a repeat every 60 seconds for up to 30 minutes. Use emergency priority carefully; for routine tests or non-critical monitoring, priority `0` is usually more appropriate.

## Test the Pushover channel

1. Save the configuration file if you changed credentials.
2. Open the FM-DX Webserver admin interface.
3. Open **FM Monitor**.
4. Enable **Pushover notifications** and save the panel settings.
5. Click **Test Pushover**.

A successful test should produce a notification titled **FM-DX Watchdog test** on the configured Pushover device or devices.

## Common Pushover problems

| Problem                                       | Check                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The panel says credentials are not configured | Confirm that `pushoverUserKey` and `pushoverApiToken` exist in `plugins_configs/PushoverWatchdog.json`.            |
| Test message fails                            | Check for copied spaces or an incorrect User Key/API Token.                                                        |
| No notification arrives on the desired phone  | Make sure the device is activated in Pushover, and leave `pushoverDevice` blank unless you need a specific device. |
| Emergency alerts fail                         | Priority `2` requires valid retry and expire values; retry must be at least 30 seconds.                            |

---

# Telegram Bot

Telegram delivery is useful when alerts should go to a private chat, an operations group, or a dedicated forum topic. The plugin sends plain text messages using the Telegram Bot API `sendMessage` method.

## Requirements

You need:

1. a Telegram account;
2. a bot created through **@BotFather**;
3. the bot token;
4. the target chat ID;
5. optionally, a topic/message thread ID when alerts should be delivered to a specific forum topic.

## Create the bot and obtain its token

1. In Telegram, open the verified bot **@BotFather**.

2. Send the command:

   ```text
   /newbot
   ```

3. Follow BotFather's instructions to choose a bot name and username.

4. BotFather will return an HTTP API token. It looks similar to:

   ```text
   123456789:AAExampleTokenThatMustBeKeptPrivate
   ```

5. Store the token securely. Anyone who has this token can operate the bot through the Bot API.

Official Telegram guide: [From BotFather to 'Hello World'](https://core.telegram.org/bots/tutorial)

## Prepare the destination chat

### Private chat

1. Open the bot you created in Telegram.
2. Press **Start**, or send it a message such as `test`.
3. Retrieve the chat ID using the method described below.

A bot cannot start a normal private conversation with a user who has never interacted with it.

### Group or supergroup

1. Add the bot to the group that should receive alerts.
2. Send a message in that group after adding the bot.
3. Retrieve the group chat ID using the method described below.

### Channel

Add the bot to the channel and give it permission to post messages, then use the channel identifier accepted by Telegram for message delivery. A private channel normally requires its numeric chat ID; a public channel can also be addressed through its username when supported by the Bot API.

## Find the Telegram chat ID

The simplest setup method is to make the bot receive one message, then inspect its updates.

1. Send a message in the intended destination: privately to the bot, in the target group, or in the target topic.

2. Open the following address in a browser, replacing the placeholder with your bot token:

   ```text
   https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/getUpdates
   ```

3. Look in the JSON response for a message object and its chat identifier:

   ```json
   {
     "message": {
       "chat": {
         "id": -1001234567890
       }
     }
   }
   ```

4. Copy the value of `message.chat.id` into `telegramChatId` or the **Chat ID** field in the panel.

If `getUpdates` returns no relevant messages, send a fresh message to the bot or group and try again. If the bot already uses a webhook in another application, Telegram does not allow `getUpdates` while that webhook is active; avoid disrupting an existing bot integration unless you intend to reuse that bot only for this plugin.

Official Bot API reference: [getUpdates](https://core.telegram.org/bots/api#getupdates)

## Send alerts to a Telegram topic

For a forum topic, the plugin supports the optional `telegramThreadId` setting.

1. Add the bot to the forum-enabled group or use the intended topic-enabled private chat.
2. Send a message inside the target topic.
3. Call `getUpdates` as described above.
4. In the message object, find `message_thread_id`.
5. Enter that value into **Topic / message thread ID** in the panel, or into `telegramThreadId` in the JSON configuration.

Leave this field empty when alerts should go to the main chat rather than to a particular topic.

Official Bot API reference: [sendMessage](https://core.telegram.org/bots/api#sendmessage)

## Configure Pushover Watchdog for Telegram

Enter the bot token directly in `plugins_configs/PushoverWatchdog.json`:

```json
{
  "telegramEnabled": true,
  "telegramBotToken": "YOUR_TELEGRAM_BOT_TOKEN",
  "telegramChatId": "YOUR_TELEGRAM_CHAT_ID",
  "telegramThreadId": ""
}
```

The token must be edited in the JSON file. The chat ID and optional thread ID can also be edited later from the **FM Monitor** panel.

## Telegram settings in the panel

| Setting                           | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| **Enable Telegram notifications** | Turns Telegram delivery on or off independently of the other channels.         |
| **Chat ID**                       | Destination user, group or channel chat identifier.                            |
| **Topic / message thread ID**     | Optional. Restricts delivery to a forum topic. Leave empty for ordinary chats. |

## Test the Telegram channel

1. Save the bot token in `plugins_configs/PushoverWatchdog.json`.
2. In the admin interface, open **FM Monitor**.
3. Enable **Telegram notifications**.
4. Fill in the **Chat ID** and, when required, the **Topic / message thread ID**.
5. Save the panel settings.
6. Click **Test Telegram**.

A successful test produces a Telegram message titled **FM-DX Watchdog test** in the configured destination.

## Common Telegram problems

| Problem                                      | Check                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot token is rejected                        | Copy the token again from BotFather and make sure it has not been revoked.                                                                                                  |
| Private chat test fails                      | Open the bot and press **Start** before sending the test.                                                                                                                   |
| Group does not receive messages              | Confirm the bot is present in the group and that the Chat ID belongs to that group.                                                                                         |
| Topic receives nothing                       | Confirm `telegramThreadId` was taken from a message inside that exact topic.                                                                                                |
| `getUpdates` returns an error about webhooks | The bot is already configured for webhook delivery elsewhere; use a separate bot for Pushover Watchdog or deliberately remove the existing webhook only when safe to do so. |

---

# Zabbix sender / trapper

Zabbix integration is intended for installations that already use Zabbix for monitoring and alert correlation. Unlike Pushover and Telegram, it does not require an API token. Pushover Watchdog sends each alert as a JSON text value through the native **Zabbix sender protocol** to a **Zabbix trapper** item.

## Requirements

You need:

1. a reachable Zabbix server or Zabbix proxy;
2. TCP access from the FM-DX Webserver machine to the Zabbix trapper port, normally `10051`;
3. a host defined in Zabbix;
4. a Zabbix trapper item on that host;
5. the technical Zabbix host name and the trapper item key.

No Zabbix API user or API token is used by this plugin.

## Create the Zabbix host and trapper item

The menu names can vary slightly between Zabbix versions, but the required item settings are the same.

1. In Zabbix, open the host that will represent the FM-DX monitor, or create a new host for it.
2. Note the host's technical **Host name**. This is the value the plugin must send; it is not necessarily the visible display name.
3. Create a new item on that host.
4. Set the item fields as follows:

| Zabbix item field       | Recommended value                                     |
| ----------------------- | ----------------------------------------------------- |
| **Name**                | `FM-DX Watchdog alert`                                |
| **Type**                | `Zabbix trapper`                                      |
| **Key**                 | `fm_dx.watchdog.alert`                                |
| **Type of information** | `Text`                                                |
| **Allowed hosts**       | IP address or DNS name of the FM-DX Webserver machine |

5. Save the item.
6. Allow time for Zabbix to update its configuration cache before testing. Depending on server configuration, a newly created trapper item may not accept values immediately.

Official Zabbix documentation: [Zabbix trapper items](https://www.zabbix.com/documentation/current/en/manual/config/items/itemtypes/trapper)

## Configure Pushover Watchdog for Zabbix

The Zabbix channel contains no secret token, so its values can be configured directly from the panel or from the JSON file:

```json
{
  "zabbixEnabled": true,
  "zabbixServer": "192.168.1.20",
  "zabbixPort": 10051,
  "zabbixHost": "FM-DX Webserver",
  "zabbixKey": "fm_dx.watchdog.alert"
}
```

The settings mean:

| Plugin setting                  | Meaning                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Zabbix server or proxy**      | Host name or IP address accepting sender/trapper data. When the monitored host is handled by a proxy, enter the proxy address. |
| **Port**                        | The Zabbix trapper port. Default: `10051`.                                                                                     |
| **Configured Zabbix host name** | Must match the technical **Host name** configured in Zabbix exactly.                                                           |
| **Trapper item key**            | Must match the key of the trapper item exactly. The default plugin key is `fm_dx.watchdog.alert`.                              |

## Value received by Zabbix

Each notification is sent as a JSON text value. A real event resembles this structure:

```json
{
  "title": "FM-DX: RDS missing",
  "message": "RDS identity missing after 30 seconds.\nFrequency: 91.600 MHz\nSignal: 54.0 dBµV...",
  "kind": "rdsMissing",
  "frequency": "91.600",
  "timestamp": "2026-06-02T18:30:00.000Z"
}
```

Possible `kind` values used by the plugin are:

| Kind             | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `noCarrier`      | Signal below threshold / probable white noise condition.                           |
| `blank`          | Carrier or usable signal exists, but modulation/audio is missing.                  |
| `rdsMissing`     | No valid RDS identity detected during the configured interval.                     |
| `stereoUnstable` | Stereo indicator became unstable or repeatedly dropped.                            |
| `recovery`       | A previously alerted condition recovered, when recovery notifications are enabled. |
| `test`           | Test message sent manually from the panel.                                         |

Because the incoming value is JSON text, Zabbix can store it as-is, or it can be used as the source for preprocessing, dependent items and triggers in more advanced deployments.

## Test the Zabbix channel

1. Make sure the trapper item has been created and is enabled.
2. Confirm that **Allowed hosts** permits the FM-DX Webserver machine to send data.
3. Open the **FM Monitor** panel.
4. Enable **Zabbix sender notifications**.
5. Enter the server/proxy address, port, exact Zabbix host name and trapper key.
6. Save the panel settings.
7. Click **Test Zabbix**.
8. In Zabbix, open **Monitoring → Latest data** and locate the trapper item.

The test value should appear as a JSON alert with `"kind":"test"`.

## Network and security note for Zabbix

The current plugin sends data through the native Zabbix sender/trapper TCP protocol and does not expose TLS/PSK configuration options. Do not publish the trapper port broadly on the public internet. Keep the FM-DX-to-Zabbix path on a trusted LAN, a VPN, or another protected network segment, and restrict the item's **Allowed hosts** value to the FM-DX server address whenever possible.

Official protocol documentation: [Zabbix sender protocol](https://www.zabbix.com/documentation/current/en/manual/appendix/protocols/zabbix_sender)

## Common Zabbix problems

| Problem                                   | Check                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test returns a failure                    | Confirm the Zabbix server/proxy address and that TCP port `10051` is reachable from the FM-DX machine.                                               |
| Zabbix reports rejected/failed data       | Verify that the technical host name and item key match exactly, and that the item type is **Zabbix trapper**.                                        |
| Item exists but no data is received       | Check **Allowed hosts** and wait for the configuration cache to refresh after creating or editing the item.                                          |
| Data arrives but is not useful for graphs | The plugin sends structured text events. Use Text storage, then optionally create dependent/preprocessed items for numeric or categorized reporting. |

---

# Using more than one notification channel

Pushover, Telegram and Zabbix are independent outputs. A common arrangement is:

* **Pushover** for immediate notifications to an operator's phone;
* **Telegram** for a shared operations chat or broadcast team group;
* **Zabbix** for central history, correlation and further automation.

Enable the channels you need in the panel. When an alert is detected, Pushover Watchdog attempts delivery through every enabled channel. A failure in one service does not prevent the plugin from attempting the others.

## Minimal combined configuration example

```json
{
  "pushoverEnabled": true,
  "pushoverUserKey": "YOUR_PUSHOVER_USER_KEY",
  "pushoverApiToken": "YOUR_PUSHOVER_API_TOKEN",
  "pushoverDevice": "",
  "pushoverSound": "pushover",
  "pushoverPriority": 0,

  "telegramEnabled": true,
  "telegramBotToken": "YOUR_TELEGRAM_BOT_TOKEN",
  "telegramChatId": "YOUR_TELEGRAM_CHAT_ID",
  "telegramThreadId": "",

  "zabbixEnabled": true,
  "zabbixServer": "192.168.1.20",
  "zabbixPort": 10051,
  "zabbixHost": "FM-DX Webserver",
  "zabbixKey": "fm_dx.watchdog.alert",

  "sendRecoveryNotifications": true,
  "includeRdsInfo": true
}
```

## References

* Pushover Message API: https://pushover.net/api
* Telegram bot setup guide: https://core.telegram.org/bots/tutorial
* Telegram Bot API: https://core.telegram.org/bots/api
* Zabbix trapper items: https://www.zabbix.com/documentation/current/en/manual/config/items/itemtypes/trapper
* Zabbix sender protocol: https://www.zabbix.com/documentation/current/en/manual/appendix/protocols/zabbix_sender
