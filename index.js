require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios      = require('axios');
const cron       = require('node-cron');
const express    = require('express');
const fs         = require('fs');
const path       = require('path');


// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
// Render automatically sets RENDER_EXTERNAL_URL — use it as fallback so you
// don't need to set WEBHOOK_URL manually in the Render dashboard.
const WEBHOOK_URL   = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // Telegram group chat ID (negative number)
const PORT          = process.env.PORT || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10); // minutes

if (!BOT_TOKEN)   throw new Error('BOT_TOKEN is not set!');
if (!WEBHOOK_URL) throw new Error('Neither WEBHOOK_URL nor RENDER_EXTERNAL_URL is set!');
if (!GROUP_CHAT_ID) {
    console.warn('⚠️  GROUP_CHAT_ID is not set — solve alerts and reminders will be disabled until you set it in Render and redeploy.');
}

// ─── JSON Data Store ──────────────────────────────────────────────────────────
// Stores registered handles and solve counts.
// NOTE: Persists across restarts but resets on fresh Render deploys.
// For permanent storage, swap this section with a database (e.g. Firebase, MongoDB).
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadData() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        const empty = { handles: {} };
        fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2));
        return empty;
    }
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch {
        return { handles: {} };
    }
}

function saveData(data) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Data shape:
// {
//   handles: {
//     "<telegramUsernameLower>": {
//       telegramUsername: string,   // original casing
//       cfHandle: string,           // Codeforces handle
//       lastSubmissionId: number|null,
//       solveCount: number
//     }
//   }
// }

// ─── Express + Webhook ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);

// Register the webhook with Telegram on startup
bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`)
    .then(() => console.log('✅ Webhook registered successfully'))
    .catch(err => console.error('❌ Webhook registration failed:', err.message));

// Telegram sends updates to this endpoint.
// Respond 200 IMMEDIATELY so Telegram never times out and retries,
// then process the update asynchronously.
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    res.sendStatus(200);
    setImmediate(() => bot.processUpdate(req.body));
});

// Health-check endpoint — ping this via UptimeRobot to keep Render free tier awake
app.get('/', (_req, res) => res.send('🤖 CP Group Bot is running!'));

app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

// ─── Codeforces API Helpers ───────────────────────────────────────────────────
const CF_API = 'https://codeforces.com/api';

// Fetch the N most recent submissions for a handle (newest first)
async function getCFSubmissions(handle, count = 20) {
    const { data } = await axios.get(`${CF_API}/user.status`, {
        params: { handle, from: 1, count },
        timeout: 10000
    });
    if (data.status !== 'OK') throw new Error(data.comment);
    return data.result;
}

// Fetch all contests that haven't started yet
async function getCFContests() {
    const { data } = await axios.get(`${CF_API}/contest.list`, { timeout: 10000 });
    if (data.status !== 'OK') throw new Error(data.comment);
    return data.result.filter(c => c.phase === 'BEFORE');
}

// Verify a Codeforces handle exists
async function verifyCFHandle(handle) {
    try {
        const { data } = await axios.get(`${CF_API}/user.info`, {
            params: { handles: handle },
            timeout: 10000
        });
        return data.status === 'OK';
    } catch {
        return false;
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

// Build the direct problem link from a submission object
function problemLink(sub) {
    const { contestId, index } = sub.problem;
    return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const HELP_TEXT =
    `📌 *CP Bot Commands:*\n\n` +
    `/addhandle @Username CFHandle — Register a Codeforces handle\n` +
    `/removehandle @Username — Remove a handle\n` +
    `/handles — List all registered handles\n` +
    `/leaderboard — Total problems solved by all members\n` +
    `/contests — Upcoming Codeforces contests\n` +
    `/getchatid — Show this chat's ID (for setup)\n` +
    `/help — Show this menu`;

// /getchatid — prints the current chat's ID so you can copy it into Render env vars
bot.onText(/\/getchatid(?:@\S+)?(?:\s|$)/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        `🆔 *Chat ID:* \`${msg.chat.id}\`\n_Copy this value and set it as GROUP\_CHAT\_ID in your Render environment variables._`,
        { parse_mode: 'Markdown' }
    );
});

// /start
bot.onText(/\/start(?:@\S+)?(?:\s|$)/, (msg) => {
    const name = msg.from.first_name || 'Coder';
    bot.sendMessage(
        msg.chat.id,
        `👋 Welcome *${name}*! I'm your CP Group Bot 🤖\n\n${HELP_TEXT}`,
        { parse_mode: 'Markdown' }
    );
});

// /help
bot.onText(/\/help(?:@\S+)?(?:\s|$)/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });
});

// /addhandle with wrong/missing arguments — show usage hint
bot.onText(/\/addhandle(?:@\S+)?(?:\s+\S+)?$/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        `⚠️ *Usage:* \`/addhandle @TelegramUsername CodeforcesHandle\`\n\n` +
        `*Example:* \`/addhandle @beblet tourist\``,
        { parse_mode: 'Markdown' }
    );
});

// /addhandle @TelegramUsername CodeforcesHandle
// Adds (or updates) a handle mapping. Verifies the CF handle exists before saving.
bot.onText(/\/addhandle(?:@\S+)?\s+@?(\S+)\s+(\S+)/i, async (msg, match) => {
    const chatId          = msg.chat.id;
    const telegramUsername = match[1].replace(/^@/, '');
    const cfHandle        = match[2];

    const verifying = await bot.sendMessage(chatId, `🔍 Verifying \`${cfHandle}\` on Codeforces…`, { parse_mode: 'Markdown' });

    const valid = await verifyCFHandle(cfHandle);
    bot.deleteMessage(chatId, verifying.message_id).catch(() => {});

    if (!valid) {
        return bot.sendMessage(
            chatId,
            `❌ Codeforces handle \`${cfHandle}\` not found. Please check the spelling.`,
            { parse_mode: 'Markdown' }
        );
    }

    // Snapshot the latest submission ID so we only track NEW solves going forward
    let lastId = null;
    try {
        const subs = await getCFSubmissions(cfHandle, 1);
        lastId = subs.length ? subs[0].id : null;
    } catch { /* user has no submissions yet */ }

    const db  = loadData();
    const key = telegramUsername.toLowerCase();

    // Preserve existing solve count if re-registering
    const existing = db.handles[key];
    db.handles[key] = {
        telegramUsername,            // preserve original casing
        cfHandle,
        lastSubmissionId: lastId,
        solveCount: existing ? existing.solveCount : 0
    };
    saveData(db);

    bot.sendMessage(
        chatId,
        `✅ *@${telegramUsername}* registered with Codeforces handle \`${cfHandle}\`\nNew solves will now be announced here! 🎯`,
        { parse_mode: 'Markdown' }
    );
});

// /removehandle @TelegramUsername
bot.onText(/\/removehandle(?:@\S+)?\s+@?(\S+)/i, (msg, match) => {
    const chatId   = msg.chat.id;
    const key      = match[1].replace(/^@/, '').toLowerCase();
    const db       = loadData();

    if (!db.handles[key]) {
        return bot.sendMessage(chatId, `ℹ️ No handle registered for @${match[1].replace(/^@/, '')}.`);
    }
    const username = db.handles[key].telegramUsername;
    delete db.handles[key];
    saveData(db);
    bot.sendMessage(chatId, `✅ Removed handle for *@${username}*.`, { parse_mode: 'Markdown' });
});

// /handles — list all registered handles
bot.onText(/\/handles(?:@\S+)?(?:\s|$)/, (msg) => {
    const db      = loadData();
    const entries = Object.values(db.handles);

    if (!entries.length) {
        return bot.sendMessage(
            msg.chat.id,
            'ℹ️ No handles registered yet.\nUse: /addhandle @Username CFHandle'
        );
    }
    const list = entries
        .map(e => `• @${e.telegramUsername} → \`${e.cfHandle}\``)
        .join('\n');
    bot.sendMessage(msg.chat.id, `📋 *Registered Handles:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// /leaderboard — sorted by total problems solved
bot.onText(/\/leaderboard(?:@\S+)?(?:\s|$)/, (msg) => {
    const db      = loadData();
    const entries = Object.values(db.handles);

    if (!entries.length) {
        return bot.sendMessage(msg.chat.id, 'ℹ️ No handles registered yet.');
    }
    const sorted  = [...entries].sort((a, b) => (b.solveCount || 0) - (a.solveCount || 0));
    const medals  = ['🥇', '🥈', '🥉'];
    const rows    = sorted
        .map((e, i) => `${medals[i] || `${i + 1}.`} @${e.telegramUsername} — *${e.solveCount || 0}* solves  (\`${e.cfHandle}\`)`)
        .join('\n');
    bot.sendMessage(msg.chat.id, `🏆 *Leaderboard*\n\n${rows}`, { parse_mode: 'Markdown' });
});

// /contests — upcoming Codeforces contests (next 5)
bot.onText(/\/contests(?:@\S+)?(?:\s|$)/, async (msg) => {
    const chatId  = msg.chat.id;
    const pending = await bot.sendMessage(chatId, '⏳ Fetching contests…');

    try {
        const contests = await getCFContests();
        bot.deleteMessage(chatId, pending.message_id).catch(() => {});

        if (!contests.length) {
            return bot.sendMessage(chatId, '😴 No upcoming Codeforces contests right now.');
        }
        const now   = Date.now();
        const lines = contests.slice(0, 5).map(c => {
            const start = new Date(c.startTimeSeconds * 1000);
            const diff  = start - now;
            return (
                `🏆 *${c.name}*\n` +
                `📅 ${start.toUTCString()}\n` +
                `⏳ Starts in: *${formatDuration(diff)}*\n` +
                `⏱ Duration: ${formatDuration(c.durationSeconds * 1000)}\n` +
                `🔗 https://codeforces.com/contest/${c.id}`
            );
        }).join('\n\n─────────────────────\n\n');

        bot.sendMessage(
            chatId,
            `📅 *Upcoming Codeforces Contests:*\n\n${lines}`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    } catch (err) {
        bot.deleteMessage(chatId, pending.message_id).catch(() => {});
        bot.sendMessage(chatId, `❌ Failed to fetch contests: ${err.message}`);
    }
});

// Unknown-command catch-all
bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) {
        const known = ['/start', '/help', '/addhandle', '/removehandle', '/handles', '/leaderboard', '/contests', '/getchatid'];
        const cmd   = msg.text.split(' ')[0].split('@')[0];
        if (!known.includes(cmd)) {
            bot.sendMessage(msg.chat.id, `❓ Unknown command. Use /help to see available commands.`);
        }
    }
    // Log every message for debugging
    console.log(`[${new Date().toISOString()}] Chat: ${msg.chat.id} | User: ${msg.from?.username || msg.from?.first_name} | Text: ${msg.text}`);
});

// ─── Cron: Poll Codeforces for New Accepted Submissions ──────────────────────
// Runs every POLL_INTERVAL minutes (default 5).
// For each registered handle it fetches the 20 most recent submissions and
// announces any AC submissions newer than the stored lastSubmissionId.
cron.schedule(`*/${POLL_INTERVAL} * * * *`, async () => {
    const db    = loadData();
    const users = Object.entries(db.handles);
    if (!users.length) return;

    let changed = false;

    for (const [key, user] of users) {
        try {
            const subs     = await getCFSubmissions(user.cfHandle, 20);
            const accepted = subs.filter(s => s.verdict === 'OK');

            // First-time baseline: just record the latest ID, don't post anything
            if (user.lastSubmissionId === null) {
                if (accepted.length) {
                    db.handles[key].lastSubmissionId = accepted[0].id;
                    changed = true;
                }
                continue;
            }

            // Collect submissions newer than the last known one
            const newSolves = accepted.filter(s => s.id > user.lastSubmissionId);

            if (newSolves.length > 0) {
                // Advance the cursor
                db.handles[key].lastSubmissionId = Math.max(...newSolves.map(s => s.id));
                db.handles[key].solveCount       = (db.handles[key].solveCount || 0) + newSolves.length;
                changed = true;

                // Post in chronological order (oldest first)
                for (const sub of newSolves.reverse()) {
                    const prob   = sub.problem;
                    const rating = prob.rating ? `⭐ Rating: *${prob.rating}*` : `⭐ Rating: *Unrated*`;

                    const message =
                        `🚀 *CP UPDATE*\n\n` +
                        `@${user.telegramUsername} solved: *${prob.name}*\n` +
                        `${rating}\n` +
                        `🔗 ${problemLink(sub)}`;

                    await bot.sendMessage(GROUP_CHAT_ID, message, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });

                    // Small delay to respect Telegram rate limits (30 msgs/sec)
                    await sleep(500);
                }
            }
        } catch (err) {
            console.error(`[Poll] ${user.cfHandle}: ${err.message}`);
        }
    }

    if (changed) saveData(db);
});

// ─── Cron: Contest Reminders — checked every minute ──────────────────────────
// Posts a reminder in the group at exactly 60 min and 15 min before each contest.
// Uses a ±30-second window to avoid missing the minute boundary.
cron.schedule('* * * * *', async () => {
    try {
        const contests = await getCFContests();
        const now      = Date.now();

        for (const c of contests) {
            const diff          = c.startTimeSeconds * 1000 - now;
            const startTimeStr  = new Date(c.startTimeSeconds * 1000).toUTCString();

            const isOneHour    = diff > 59.5 * 60000 && diff <= 60.5 * 60000;
            const isFifteenMin = diff > 14.5 * 60000 && diff <= 15.5 * 60000;

            if (isOneHour || isFifteenMin) {
                const label   = isOneHour ? '1 hour' : '15 minutes';
                const message =
                    `⚠️ *Upcoming Contest Reminder*\n\n` +
                    `📌 Contest Name: *${c.name}*\n` +
                    `⏰ Starts in: *${label}*\n` +
                    `🕐 Start Time: ${startTimeStr}\n` +
                    `⏱ Duration: ${formatDuration(c.durationSeconds * 1000)}\n` +
                    `🔗 https://codeforces.com/contest/${c.id}`;

                await bot.sendMessage(GROUP_CHAT_ID, message, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            }
        }
    } catch (err) {
        console.error('[Reminders]', err.message);
    }
});

// ─── Cron: Daily Summary at 09:00 UTC ────────────────────────────────────────
// Posts a leaderboard-style summary every morning.
cron.schedule('0 9 * * *', () => {
    const db      = loadData();
    const entries = Object.values(db.handles);
    if (!entries.length) return;

    const sorted = [...entries].sort((a, b) => (b.solveCount || 0) - (a.solveCount || 0));
    const medals = ['🥇', '🥈', '🥉'];
    const active = sorted.filter(e => (e.solveCount || 0) > 0);

    const rows = active.length
        ? active.map((e, i) =>
            `${medals[i] || `${i + 1}.`} @${e.telegramUsername} — *${e.solveCount}* problems solved`
          ).join('\n')
        : '_No problems solved yet. Time to grind!_ 💪';

    bot.sendMessage(
        GROUP_CHAT_ID,
        `📊 *Daily CP Summary*\n\n${rows}\n\nKeep grinding! 💪`,
        { parse_mode: 'Markdown' }
    );
});
