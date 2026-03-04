# 🐴 CPHorse — Competitive Programming Telegram Bot

A Telegram group bot that tracks Codeforces solves, announces them live, runs contest reminders, and shows an all-time leaderboard.

---

## 📋 Table of Contents

1. [Features](#features)
2. [Step 1 — Create a Bot with BotFather](#step-1--create-a-bot-with-botfather)
3. [Step 2 — Create a Telegram Group & Add the Bot](#step-2--create-a-telegram-group--add-the-bot)
4. [Step 3 — Get Your Group Chat ID](#step-3--get-your-group-chat-id)
5. [Step 4 — Deploy on Render](#step-4--deploy-on-render)
6. [Step 5 — Set Environment Variables on Render](#step-5--set-environment-variables-on-render)
7. [Step 6 — Register Member Handles](#step-6--register-member-handles)
8. [Bot Commands Reference](#bot-commands-reference)
9. [Keep the Bot Awake (UptimeRobot)](#keep-the-bot-awake-uptimerobot)
10. [Local Development](#local-development)
11. [Project Structure](#project-structure)

---

## Features

| Feature | Details |
|---|---|
| 🚀 Live solve alerts | Announces every new Accepted submission in the group |
| 🏆 All-time leaderboard | Fetches real distinct problem counts from Codeforces |
| ⚠️ Contest reminders | Posts in group at 1 hour and 15 minutes before any CF contest |
| 📊 Daily summary | Posts a morning leaderboard every day at 09:00 UTC |
| 📋 Handle registry | Register/remove Codeforces handles per Telegram user |

---

## Step 1 — Create a Bot with BotFather

1. Open Telegram and search for **@BotFather** or click [t.me/BotFather](https://t.me/BotFather)
2. Start a chat and send:
   ```
   /newbot
   ```
3. BotFather will ask for a **name** (display name, e.g. `CP Horse Bot`)
4. Then ask for a **username** — must end in `bot` (e.g. `CPHorseBot`)
5. BotFather replies with your **Bot Token**:
   ```
   Use this token to access the HTTP API:
   1234567890:ABCDefGhIJKlmNoPQRsTUVwxyZ
   ```
6. **Copy and save this token** — you will need it as `BOT_TOKEN`

> ⚠️ Never share your bot token publicly. Anyone with it can control your bot.

---

## Step 2 — Create a Telegram Group & Add the Bot

1. In Telegram tap the **pencil / compose** icon → **New Group**
2. Give the group a name (e.g. `CP Group`)
3. Search for your bot's username (e.g. `@CPHorseBot`) and add it as a member
4. Tap **Create**
5. **Promote the bot to Admin** so it can send messages:
   - Open Group → tap the group name → **Edit** → **Administrators** → **Add Administrator** → select your bot
   - Enable: **Post Messages** (minimum required)
   - Save

---

## Step 3 — Get Your Group Chat ID

The bot needs your group's numeric Chat ID to post messages automatically.

1. Make sure the bot is already in the group (Step 2 done)
2. Send **any message** in the group (e.g. `hello`)
3. Open this URL in your browser (replace `BOT_TOKEN` with your actual token):
   ```
   https://api.telegram.org/botBOT_TOKEN/getUpdates
   ```
   Example:
   ```
   https://api.telegram.org/bot1234567890:ABCDefGhIJKlmNoPQRsTUVwxyZ/getUpdates
   ```
4. In the JSON response, find:
   ```json
   "chat": {
     "id": -1009876543210,
     "title": "CP Group",
     "type": "supergroup"
   }
   ```
5. The **negative number** (e.g. `-1009876543210`) is your `GROUP_CHAT_ID`

> 💡 **Alternative:** Once the bot is deployed and running, just send `/getchatid` in the group and the bot will reply with the ID directly.

> ⚠️ If `getUpdates` returns `{"ok":true,"result":[]}`, a webhook may already be registered. Visit this URL first to clear it, then retry:
> ```
> https://api.telegram.org/botBOT_TOKEN/deleteWebhook
> ```

---

## Step 4 — Deploy on Render

### 4.1 — Push the code to GitHub

If not already done:

```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -m main
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 4.2 — Create a Web Service on Render

1. Go to [render.com](https://render.com) and sign up / log in (free)
2. Click **New +** → **Web Service**
3. Click **Connect a repository** → authorize GitHub → select your repo
4. Render auto-detects `render.yaml` — review the settings:

   | Field | Value |
   |---|---|
   | Name | `cp-telegram-bot` (or anything) |
   | Environment | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Plan | `Free` |

5. Click **Create Web Service**

Render will begin the first deploy. It will **fail** until you set the environment variables in Step 5.

---

## Step 5 — Set Environment Variables on Render

1. In your Render service page, click the **Environment** tab
2. Add the following **Key / Value** pairs:

   | Key | Value | Notes |
   |---|---|---|
   | `BOT_TOKEN` | `1234567890:ABCxyz…` | From BotFather (Step 1) |
   | `GROUP_CHAT_ID` | `-1009876543210` | From Step 3 (negative number) |
   | `POLL_INTERVAL` | `5` | How often (minutes) to check for new CF solves |

   > `WEBHOOK_URL` does **not** need to be set — Render provides it automatically via `RENDER_EXTERNAL_URL`.

3. Click **Save Changes**
4. Render automatically redeploys with the new variables

### 5.1 — Verify the deploy succeeded

In the Render **Logs** tab you should see:
```
🌐 Server listening on port 10000
✅ Webhook registered successfully
```

If you see `BOT_TOKEN is not set!` or `GROUP_CHAT_ID is not set!`, double-check your environment variables.

---

## Step 6 — Register Member Handles

Once the bot is live, register each group member's Codeforces handle:

```
/addhandle @TelegramUsername CodeforcesHandle
```

**Examples:**
```
/addhandle @john tourist
/addhandle @alice Petr
/addhandle @bob um_nik
```

The bot will:
1. Verify the Codeforces handle exists
2. Snapshot the latest submission ID (so old solves are not re-announced)
3. Confirm registration in the group

From that point on, every new Accepted submission by that user triggers a group message like:

```
🚀 CP UPDATE

@john solved: Two Buttons
⭐ Rating: 1900
🔗 https://codeforces.com/problemset/problem/4/B
```

---

## Bot Commands Reference

| Command | Description |
|---|---|
| `/addhandle @Username CFHandle` | Register a Codeforces handle for a member |
| `/removehandle @Username` | Remove a member's handle |
| `/handles` | List all registered handles |
| `/leaderboard` | All-time leaderboard (live from Codeforces) |
| `/contests` | Next 5 upcoming Codeforces contests |
| `/getchatid` | Show the current chat's ID |
| `/help` | Show all commands |
| `/start` | Welcome message |

---

## Keep the Bot Awake (UptimeRobot)

Render's free tier **spins down** after 15 minutes of inactivity, causing a 30–60 second cold start delay where messages are missed.

**Fix — set up a free uptime monitor:**

1. Go to [uptimerobot.com](https://uptimerobot.com) and create a free account
2. Click **Add New Monitor**
3. Set:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** CPHorse Bot
   - **URL:** `https://YOUR-APP-NAME.onrender.com` (your Render service URL)
   - **Monitoring Interval:** Every **5 minutes**
4. Click **Create Monitor**

This pings your bot every 5 minutes, keeping the instance warm 24/7.

---

## Local Development

1. **Clone the repo:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/CPHorse.git
   cd CPHorse
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create your `.env` file:**
   ```bash
   cp .env.example .env
   ```
   Then fill in the values:
   ```env
   BOT_TOKEN=your_bot_token_here
   WEBHOOK_URL=https://your-app.onrender.com
   GROUP_CHAT_ID=-1009876543210
   POLL_INTERVAL=5
   PORT=3000
   ```

4. **For local testing, switch to polling mode temporarily** by changing line in `index.js`:
   ```js
   // Replace webhook setup with:
   const bot = new TelegramBot(BOT_TOKEN, { polling: true });
   ```

5. **Run the bot:**
   ```bash
   npm start
   ```

> ⚠️ Do not commit `.env` — it is already in `.gitignore`

---

## Project Structure

```
CPHorse/
├── index.js          # Main bot logic
├── package.json      # Dependencies and start script
├── render.yaml       # Render deployment config
├── .env.example      # Template for environment variables
├── .gitignore        # Excludes node_modules, .env, data/data.json
├── README.md         # This file
└── data/
    └── data.json     # Auto-created — stores registered handles (runtime only)
```

### Data file shape (`data/data.json`)
```json
{
  "handles": {
    "john": {
      "telegramUsername": "john",
      "cfHandle": "tourist",
      "lastSubmissionId": 123456789,
      "solveCount": 42
    }
  }
}
```

> ⚠️ `data/data.json` is **not** committed to git and resets on a fresh Render deploy. For permanent persistence, replace the JSON store with a database like Firebase or MongoDB Atlas (both have free tiers).

---

## Environment Variables Summary

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ Yes | Telegram bot token from BotFather |
| `GROUP_CHAT_ID` | ✅ Yes | Telegram group chat ID (negative number) |
| `WEBHOOK_URL` | ❌ No | Auto-detected from `RENDER_EXTERNAL_URL` on Render |
| `POLL_INTERVAL` | ❌ No | CF polling frequency in minutes (default: `5`) |
| `PORT` | ❌ No | HTTP port (default: `3000`, auto-set by Render) |
