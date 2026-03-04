require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios      = require('axios');
const cron       = require('node-cron');
const express    = require('express');


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

// ─── Upstash Redis Data Store ─────────────────────────────────────────────────
// Uses Upstash Redis REST API — free tier, survives every deploy/restart.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render env vars.
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY     = 'cp-bot-data';

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('⚠️  Upstash env vars not set — data will NOT persist across deploys! Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
}

async function loadData() {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return { handles: {} };
    try {
        const res = await axios.get(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
            timeout: 8000
        });
        const raw = res.data.result;
        return raw ? JSON.parse(raw) : { handles: {} };
    } catch (err) {
        console.error('[Redis] loadData error:', err.message);
        return { handles: {} };
    }
}

async function saveData(data) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
    try {
        await axios.post(
            `${UPSTASH_URL}/set/${REDIS_KEY}`,
            JSON.stringify(data),
            { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
        );
    } catch (err) {
        console.error('[Redis] saveData error:', err.message);
    }
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

// Fetch total count of DISTINCT problems ever solved (AC) on Codeforces for a handle.
// Fetches up to 10 000 submissions and counts unique problem IDs.
async function getCFAllTimeSolves(handle) {
    const { data } = await axios.get(`${CF_API}/user.status`, {
        params: { handle, from: 1, count: 10000 },
        timeout: 15000
    });
    if (data.status !== 'OK') throw new Error(data.comment);
    const solved = new Set();
    for (const sub of data.result) {
        if (sub.verdict === 'OK') {
            solved.add(`${sub.problem.contestId}-${sub.problem.index}`);
        }
    }
    return solved.size;
}

// Fetch distinct problems solved TODAY (UTC midnight → now) from CF API.
// Fetches up to 300 submissions which handles even very active users within one day.
async function getCFDailySolves(handle) {
    const todayMidnightUtc = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    const { data } = await axios.get(`${CF_API}/user.status`, {
        params: { handle, from: 1, count: 300 },
        timeout: 15000
    });
    if (data.status !== 'OK') throw new Error(data.comment);
    const solved = new Set();
    for (const sub of data.result) {
        if (sub.verdict === 'OK' && sub.creationTimeSeconds >= todayMidnightUtc) {
            solved.add(`${sub.problem.contestId}-${sub.problem.index}`);
        }
    }
    return solved.size;
}

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

// Escape characters that break Telegram Markdown mode
function escMd(text) {
    return String(text).replace(/[_*`[\]]/g, '\\$&');
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const HELP_TEXT =
    `📌 *CP Bot Commands:*\n\n` +
    `/addhandle @Username CFHandle — Register a Codeforces handle\n` +
    `/removehandle @Username — Remove a handle\n` +
    `/handles — List all registered handles\n` +
    `/leaderboard — All-time problems solved by all members\n` +
    `/dailyleaderboard — Today\'s problems solved\n` +
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

    const db  = await loadData();
    const key = telegramUsername.toLowerCase();

    // Preserve existing solve count if re-registering
    const existing = db.handles[key];
    db.handles[key] = {
        telegramUsername,            // preserve original casing
        cfHandle,
        lastSubmissionId: lastId,
        solveCount: existing ? existing.solveCount : 0
    };
    await saveData(db);

    bot.sendMessage(
        chatId,
        `✅ *@${escMd(telegramUsername)}* registered with Codeforces handle \`${escMd(cfHandle)}\`\nNew solves will now be announced here! 🎯`,
        { parse_mode: 'Markdown' }
    );
});

// /removehandle @TelegramUsername
bot.onText(/\/removehandle(?:@\S+)?\s+@?(\S+)/i, async (msg, match) => {
    const chatId   = msg.chat.id;
    const key      = match[1].replace(/^@/, '').toLowerCase();
    const db       = await loadData();

    if (!db.handles[key]) {
        return bot.sendMessage(chatId, `ℹ️ No handle registered for @${match[1].replace(/^@/, '')}.`);
    }
    const username = db.handles[key].telegramUsername;
    delete db.handles[key];
    await saveData(db);
    bot.sendMessage(chatId, `✅ Removed handle for *@${escMd(username)}*.`, { parse_mode: 'Markdown' });
});

// /handles — list all registered handles
bot.onText(/\/handles(?:@\S+)?(?:\s|$)/, async (msg) => {
    const db      = await loadData();
    const entries = Object.values(db.handles);

    if (!entries.length) {
        return bot.sendMessage(
            msg.chat.id,
            'ℹ️ No handles registered yet.\nUse: /addhandle @Username CFHandle'
        );
    }
    const list = entries
        .map(e => `• @${escMd(e.telegramUsername)} → \`${escMd(e.cfHandle)}\``)
        .join('\n');
    bot.sendMessage(msg.chat.id, `📋 *Registered Handles:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// /dailyleaderboard — today's solves for all registered members (fetched live from CF API)
bot.onText(/\/dailyleaderboard(?:@\S+)?(?:\s|$)/, async (msg) => {
    const db      = await loadData();
    const entries = Object.values(db.handles);

    if (!entries.length) {
        return bot.sendMessage(msg.chat.id, 'ℹ️ No handles registered yet.');
    }

    const pending = await bot.sendMessage(msg.chat.id, '⏳ Fetching today\'s solve counts from Codeforces…');

    const results = await Promise.all(
        entries.map(async (e) => {
            try {
                const count = await getCFDailySolves(e.cfHandle);
                return { ...e, count };
            } catch {
                return { ...e, count: 0 };
            }
        })
    );

    bot.deleteMessage(msg.chat.id, pending.message_id).catch(() => {});

    const sorted = results.sort((a, b) => b.count - a.count);
    const medals = ['🥇', '🥈', '🥉'];
    const rows   = sorted
        .map((e, i) =>
            `${medals[i] || `${i + 1}.`} @${escMd(e.telegramUsername)} — *${e.count}* solved today  (\`${escMd(e.cfHandle)}\`)`
        )
        .join('\n');

    const dateStr = new Date().toISOString().slice(0, 10);
    bot.sendMessage(
        msg.chat.id,
        `📅 *Daily Leaderboard — ${dateStr} UTC*\n\n${rows}\n\n_Counts all Codeforces solves since midnight UTC_`,
        { parse_mode: 'Markdown' }
    );
});

// /leaderboard — all-time distinct problems solved on Codeforces (fetched live)
bot.onText(/\/leaderboard(?:@\S+)?(?:\s|$)/, async (msg) => {
    const db      = await loadData();
    const entries = Object.values(db.handles);

    if (!entries.length) {
        return bot.sendMessage(msg.chat.id, 'ℹ️ No handles registered yet.');
    }

    const pending = await bot.sendMessage(msg.chat.id, '⏳ Fetching all-time solve counts from Codeforces…');

    // Fetch real all-time solve counts for every registered handle
    const results = await Promise.all(
        entries.map(async (e) => {
            try {
                const total = await getCFAllTimeSolves(e.cfHandle);
                return { ...e, total };
            } catch {
                return { ...e, total: '?' };
            }
        })
    );

    bot.deleteMessage(msg.chat.id, pending.message_id).catch(() => {});

    const sorted = results.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
    const medals = ['🥇', '🥈', '🥉'];
    const rows   = sorted
        .map((e, i) =>
            `${medals[i] || `${i + 1}.`} @${escMd(e.telegramUsername)} — *${e.total}* problems solved  (\`${escMd(e.cfHandle)}\`)`
        )
        .join('\n');

    bot.sendMessage(
        msg.chat.id,
        `🏆 *All-Time Leaderboard*\n_(distinct problems solved on Codeforces)_\n\n${rows}`,
        { parse_mode: 'Markdown' }
    );
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
        const known = ['/start', '/help', '/addhandle', '/removehandle', '/handles', '/leaderboard', '/dailyleaderboard', '/contests', '/getchatid'];
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
    const db    = await loadData();
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

                // Track daily solves — reset count if it's a new UTC day
                const today = new Date().toISOString().slice(0, 10);
                if (db.handles[key].dailyDate !== today) {
                    db.handles[key].dailyDate   = today;
                    db.handles[key].dailySolves = 0;
                }
                db.handles[key].dailySolves = (db.handles[key].dailySolves || 0) + newSolves.length;

                changed = true;

                // Post in chronological order (oldest first)
                for (const sub of newSolves.reverse()) {
                    const prob   = sub.problem;
                    const rating = prob.rating ? `⭐ Rating: *${prob.rating}*` : `⭐ Rating: *Unrated*`;

                    const message =
                        `🚀 *CP UPDATE*\n\n` +
                        `@${escMd(user.telegramUsername)} solved: *${escMd(prob.name)}*\n` +
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

    if (changed) await saveData(db);
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

// ─── Cron: Daily Leaderboard at 23:59 UTC ────────────────────────────────────
// Posts today's final leaderboard (live from CF API) at 23:59 UTC.
cron.schedule('59 23 * * *', async () => {
    if (!GROUP_CHAT_ID) return;
    const db      = await loadData();
    const entries = Object.values(db.handles);
    if (!entries.length) return;

    const results = await Promise.all(
        entries.map(async (e) => {
            try {
                const count = await getCFDailySolves(e.cfHandle);
                return { ...e, count };
            } catch {
                return { ...e, count: 0 };
            }
        })
    );

    const sorted = results.sort((a, b) => b.count - a.count);
    const medals = ['🥇', '🥈', '🥉'];
    const rows   = sorted
        .map((e, i) =>
            `${medals[i] || `${i + 1}.`} @${escMd(e.telegramUsername)} — *${e.count}* solved today`
        )
        .join('\n');

    const hasActivity = results.some(e => e.count > 0);
    const today = new Date().toISOString().slice(0, 10);

    await bot.sendMessage(
        GROUP_CHAT_ID,
        `📅 *Daily Leaderboard — ${today} UTC*\n\n` +
        (hasActivity ? rows : '_No problems solved today. Grind harder tomorrow!_ 💪'),
        { parse_mode: 'Markdown' }
    );
});

// ─── Cron: Morning Summary at 09:00 UTC ───────────────────────────────────────────
// Motivational good-morning message with all-time top 3.
cron.schedule('0 9 * * *', async () => {
    const db      = await loadData();
    const entries = Object.values(db.handles);
    if (!entries.length) return;

    const sorted = [...entries].sort((a, b) => (b.solveCount || 0) - (a.solveCount || 0));
    const medals = ['🥇', '🥈', '🥉'];
    const top3   = sorted.slice(0, 3)
        .map((e, i) => `${medals[i]} @${escMd(e.telegramUsername)} — *${e.solveCount || 0}* total`)
        .join('\n');

    bot.sendMessage(
        GROUP_CHAT_ID,
        `☀️ *Good morning, grinders!*\n\nAll-time top 3:\n${top3}\n\nUse /dailyleaderboard to see today\'s progress. Keep grinding! 💪`,
        { parse_mode: 'Markdown' }
    );
});
