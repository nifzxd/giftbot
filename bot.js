const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

// ==============================
// CONFIG & ENVIRONMENT
// ==============================

// ==============================
// CONFIG (config.js)
// ==============================

const config = require("./config");

const BOT_TOKEN = config.BOT_TOKEN || process.env.BOT_TOKEN;
const OWNER_ID = Number(config.OWNER_ID || process.env.OWNER_ID || "0");

if (!BOT_TOKEN) {
  throw new Error(
    "❌ BOT_TOKEN belum di-set di config.js atau environment variables",
  );
}

if (!OWNER_ID) {
  throw new Error(
    "❌ OWNER_ID belum di-set di config.js atau environment variables",
  );
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==============================
// CUSTOM NAMA GIFT
// ==============================

const GIFT_CUSTOM_NAMES = {
  "5170145012310081615": "Hati 💖",
  "5170233102089322756": "Boneka Beruang 🧸",
  "5170250947678437525": "Kotak Hadiah 🎁",
  "5168103777563050263": "Mawar 🌹",
  "5170144170496491616": "Kue Ulang Tahun 🎂",
  "5170314324215857265": "Buket Bunga 💐",
  "5170564780938756245": "Roket 🚀",
  "5168043875654172773": "Piala 🏆",
  "5170690322832818290": "Cincin 💍",
  "5170521118301225164": "Berlian 💎",
  "6028601630662853006": "Sampanye 🍾",
};

// ==============================
// PERSISTENT STORAGE (JSON)
// ==============================

const DATA_DIR = "./data";
const USERS_FILE = `${DATA_DIR}/users.json`;
const ORDERS_FILE = `${DATA_DIR}/orders.json`;
const HISTORY_FILE = `${DATA_DIR}/history.json`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Gagal load ${file}:`, err.message);
    return [];
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Gagal save ${file}:`, err.message);
  }
}

// In-memory, dihydrate dari disk saat start
const orders = new Map(
  loadJson(ORDERS_FILE).map((o) => [String(o.buyerId), o]),
);
const users = new Map(loadJson(USERS_FILE).map((u) => [String(u.id), u]));
const history = loadJson(HISTORY_FILE);

// FIX (#4): Idempotency — payload yang sudah berhasil diproses tidak akan
// diproses ulang (mencegah gift terkirim dua kali saat update di-redeliver
// Telegram setelah proses crash/restart).
const processedPayloads = new Set(
  history.filter((h) => h.status === "SENT").map((h) => h.payload),
);

// Catat order selesai ke riwayat (dipakai /orders, /myorders, audit trail)
function addHistory(entry) {
  history.unshift(entry); // terbaru di awal
  if (history.length > 1000) history.length = 1000; // batasi ukuran file
  saveJson(HISTORY_FILE, history);
}

function saveUsers() {
  saveJson(USERS_FILE, [...users.values()]);
}

function saveOrders() {
  saveJson(ORDERS_FILE, [...orders.values()]);
}

// ==============================
// HELPER FUNCTIONS
// ==============================

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isOwner(userId) {
  return Number(userId) === OWNER_ID;
}

function trackUser(from) {
  if (!from || from.is_bot) return;
  const key = String(from.id);
  const existing = users.get(key);
  users.set(key, {
    id: from.id,
    username: from.username
      ? from.username.toLowerCase()
      : (existing?.username ?? null),
    first_name: from.first_name || (existing?.first_name ?? ""),
    updatedAt: Date.now(),
  });
  saveUsers();
}

function getGiftName(gift) {
  if (GIFT_CUSTOM_NAMES[gift.id]) {
    return GIFT_CUSTOM_NAMES[gift.id];
  }

  const emoji = gift.sticker?.emoji ? `${gift.sticker.emoji} ` : "🎁";
  return `${emoji} Gift #${gift.id}`;
}

function setOrder(userId, order) {
  orders.set(String(userId), order);
  saveOrders();
}

function clearOrder(userId) {
  orders.delete(String(userId));
  saveOrders();
}

// FIX (#1 & #2): helper — order dengan invoice aktif / hasil gagal tidak boleh
// ditimpa atau dihapus sembarangan.
function hasActivePaymentOrder(userId) {
  const o = orders.get(String(userId));
  return o && (o.status === "PAYMENT_CREATED" || o.status === "PAID");
}

// ==============================
// UI HELPERS — TYPING, EDIT & DELETE
// ==============================

// Indicator "sedang mengetik..."
async function sendTyping(chatId) {
  try {
    await bot.sendChatAction(chatId, "typing");
  } catch {
    /* abaikan */
  }
}

// FIX (#6): Pesan bot terakhir per chat disimpan dengan timestamp,
// dibersihkan berkala supaya Map tidak membengkak (memory leak).
const lastBotMsg = new Map(); // chatId(String) -> { id, at }

function rememberBotMsg(chatId, messageId) {
  lastBotMsg.set(String(chatId), { id: messageId, at: Date.now() });
}

function getLastBotMsgId(chatId) {
  return lastBotMsg.get(String(chatId))?.id;
}

// Kirim pesan baru, atau EDIT pesan bot terakhir di chat
async function sendBotMessage(chatId, text, opts = {}) {
  const last = lastBotMsg.get(String(chatId));
  if (last) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: last.id,
        ...opts,
      });
      return last.id;
    } catch {
      // fallback: kirim pesan baru
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  rememberBotMsg(chatId, sent.message_id);
  return sent.message_id;
}

// Hapus pesan bot terakhir di chat
async function clearBotMessages(chatId) {
  const last = lastBotMsg.get(String(chatId));
  if (last) {
    try {
      await bot.deleteMessage(chatId, last.id);
    } catch {
      /* abaikan */
    }
    lastBotMsg.delete(String(chatId));
  }
}

// Hapus pesan user (input username / pesan gift)
async function deleteUserMessage(msg) {
  try {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
  } catch {
    /* abaikan */
  }
}

// ==============================
// TELEGRAM API WRAPPER
// ==============================

async function telegramApi(method, data = {}) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      data,
    );
    return response.data.result;
  } catch (error) {
    const errorMsg = error.response?.data?.description || error.message;
    throw new Error(`Telegram API Error (${method}): ${errorMsg}`);
  }
}

async function getAvailableGifts(forceRefresh = false) {
  // Cache 60 detik untuk mengurangi API call
  const now = Date.now();
  if (
    !forceRefresh &&
    getAvailableGifts._cache &&
    now - getAvailableGifts._cacheAt < 60_000
  ) {
    return getAvailableGifts._cache;
  }
  const result = await telegramApi("getAvailableGifts");
  getAvailableGifts._cache = result;
  getAvailableGifts._cacheAt = now;
  return result;
}

async function sendGift(userId, giftId, text = "") {
  const payload = {
    user_id: userId,
    gift_id: giftId,
  };
  if (text) payload.text = text;
  return telegramApi("sendGift", payload);
}

async function getStarTransactions(offset = 0, limit = 20) {
  return telegramApi("getStarTransactions", { offset, limit });
}

// ==============================
// CLEANUP & AUTOSAVE
// ==============================

// Aturan cleanup:
// - Order tahap input (WAITING_*) TIDAK pernah dihapus otomatis — hilang hanya
//   saat user ketik /cancel, order ulang, atau timpa dengan gift baru.
// - PAYMENT_CREATED: dihapus setelah 24 jam (invoice sudah pasti basi).
// - PAID & FAILED: dipertahankan 24 jam untuk investigasi owner.
setInterval(
  () => {
    const now = Date.now();
    let changed = false;
    for (const [userId, order] of orders.entries()) {
      if (!order.createdAt) continue;
      if (!["PAYMENT_CREATED", "PAID", "FAILED"].includes(order.status))
        continue;
      if (now - order.createdAt > 24 * 60 * 60 * 1000) {
        orders.delete(userId);
        changed = true;
      }
    }
    if (changed) saveOrders();
  },
  5 * 60 * 1000,
);

// FIX (#6): Bersihkan lastBotMsg yang sudah lama tidak dipakai (anti memory leak)
setInterval(
  () => {
    const now = Date.now();
    for (const [chatId, entry] of lastBotMsg.entries()) {
      if (now - entry.at > 24 * 60 * 60 * 1000) lastBotMsg.delete(chatId);
    }
  },
  60 * 60 * 1000,
);

// Backup berkala ke disk (aman jika proses mati mendadak)
setInterval(saveOrders, 60 * 1000);

// ==============================
// ORDER SUMMARY HELPER
// ==============================

async function showOrderSummary(chatId, order, editMessageId = null) {
  const textPreview = order.text
    ? `💌 Pesan: <i>"${escapeHtml(order.text)}"</i>`
    : `💌 Pesan: <i>(tanpa pesan)</i>`;

  const summaryText =
    `📦 <b>Order Dibuat</b>\n\n` +
    `🎁 Gift: <b>${escapeHtml(order.giftName)}</b>\n` +
    `👤 Penerima: ${escapeHtml(order.recipientUsername)}\n` +
    `🆔 ID: <code>${order.recipientId}</code>\n` +
    `${textPreview}\n` +
    `💰 Harga: <b>${order.price} ⭐</b>\n\n` +
    `Silakan klik tombol di bawah untuk membayar:`;

  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: `💳 Bayar ${order.price} ⭐`, callback_data: "pay" }],
      ],
    },
  };

  // Edit pesan lama kalau diminta (chat tetap rapi, tidak menumpuk)
  if (editMessageId) {
    try {
      await bot.editMessageText(summaryText, {
        chat_id: chatId,
        message_id: editMessageId,
        ...options,
      });
      rememberBotMsg(chatId, editMessageId);
      return;
    } catch {
      // fallback: kirim pesan baru
    }
  }

  await sendBotMessage(chatId, summaryText, options);
}

// ==============================
// BOT COMMANDS
// ==============================

// FIX (#7): regex mendukung suffix @NamaBot untuk pemakaian di grup
// /start
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  trackUser(msg.from);
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // FIX (#2): Jangan hapus order yang masih punya invoice aktif —
  // invoice lama tetap bisa dibayar. Cukup abaikan, beri tahu user.
  if (hasActivePaymentOrder(userId)) {
    return sendBotMessage(
      chatId,
      "⚠️ Kamu masih punya invoice yang belum dibayar.\nSelesaikan pembayaran, atau ketik /cancel untuk membatalkan dan membuat order baru.",
      { parse_mode: "HTML" },
    );
  }

  clearOrder(userId);

  await sendTyping(chatId);

  const name =
    msg.from.first_name ||
    (msg.from.username ? `@${msg.from.username}` : "kak");

  await sendBotMessage(
    chatId,
    `👋 <b>Halo, ${escapeHtml(name)}!</b>\n\n` +
      `Selamat datang di <b>Nifz Gift Bot</b> 🎁\n` +
      `Kirim gift Telegram Stars ke temanmu dengan mudah dan cepat!\n\n` +
      `Silakan pilih menu di bawah ini:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎁 Lihat Gift", callback_data: "menu:gifts" }],
          [{ text: "📜 Riwayat Saya", callback_data: "menu:myorders" }],
          [{ text: "💝 Dukung Bot", callback_data: "menu:donate" }],
        ],
      },
    },
  );
});

// /cancel
bot.onText(/^\/cancel(?:@\w+)?$/, async (msg) => {
  trackUser(msg.from);
  const userId = msg.from.id;

  const order = orders.get(String(userId));

  if (!order) {
    return sendBotMessage(msg.chat.id, "Tidak ada order yang sedang berjalan.");
  }

  // Order yang pembayarannya sedang diproses tidak bisa dibatalkan
  if (order.status === "PAID") {
    return sendBotMessage(
      msg.chat.id,
      "⚠️ Pembayaranmu sedang diproses. Gift akan dikirim otomatis dalam beberapa saat.",
      { parse_mode: "HTML" },
    );
  }

  // Order dihapus INSTAN begitu user klik /cancel
  const hadInvoice = order.status === "PAYMENT_CREATED";
  clearOrder(userId);
  // Hapus pesan summary/invoice yang tersisa supaya chat rapi
  await clearBotMessages(msg.chat.id);

  let text = "✅ Order berhasil dibatalkan.\n\nKetik /start untuk order baru.";
  if (hadInvoice) {
    text =
      "✅ Order berhasil dibatalkan.\n\n" +
      "⚠️ Peringatan: invoice yang sudah terkirim mungkin MASIH BISA dibayar. " +
      "Jika kamu terlanjur membayar setelah pembatalan, hubungi admin dengan bukti pembayaran.";
  }
  return sendBotMessage(msg.chat.id, text);
});

// /transactions (Owner Only)
bot.onText(/^\/transactions(?:@\w+)?$/, async (msg) => {
  trackUser(msg.from);
  if (!isOwner(msg.from.id)) {
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");
  }

  await sendTyping(msg.chat.id);

  try {
    const data = await getStarTransactions(0, 20);
    const transactions = data?.transactions || [];

    if (!transactions.length) {
      return sendBotMessage(msg.chat.id, "📭 Belum ada transaksi Stars.");
    }

    let text = "📊 <b>20 TRANSAKSI TERAKHIR</b>\n\n";
    for (const tx of transactions) {
      const sign = tx.amount >= 0 ? "+" : "";
      const partner = tx.source?.type || tx.receiver?.type || "unknown";
      text += `⭐ ${sign}${tx.amount}\n🔹 ${escapeHtml(partner)}\n🆔 <code>${escapeHtml(tx.id)}</code>\n\n`;
    }

    await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error(err.message);
    sendBotMessage(
      msg.chat.id,
      `❌ Gagal mengambil transaksi.\n\n${escapeHtml(err.message)}`,
    );
  }
});

// /stats (Owner Only)
bot.onText(/^\/stats(?:@\w+)?$/, (msg) => {
  trackUser(msg.from);
  if (!isOwner(msg.from.id)) {
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");
  }

  const activeOrders = orders.size;
  const totalUsers = users.size;
  const paidOrders = [...orders.values()].filter(
    (o) => o.status === "PAID",
  ).length;

  sendBotMessage(
    msg.chat.id,
    `📈 <b>STATISTIK BOT</b>\n\n👥 Total User Terdata: <b>${totalUsers}</b>\n📦 Order Aktif: <b>${activeOrders}</b>\n💰 Order Terbayar (pending kirim): <b>${paidOrders}</b>`,
    { parse_mode: "HTML" },
  );
});

// /orders [jumlah] (Owner Only) — riwayat order lokal
bot.onText(/^\/orders(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
  trackUser(msg.from);
  if (!isOwner(msg.from.id)) {
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");
  }

  const limit = Math.min(Math.max(Number(match[1] || 10), 1), 50);

  if (!history.length) {
    return sendBotMessage(msg.chat.id, "📭 Belum ada riwayat order.");
  }

  await sendTyping(msg.chat.id);

  let text = `📜 <b>RIWAYAT ORDER TERAKHIR (${Math.min(limit, history.length)})</b>\n\n`;
  for (const h of history.slice(0, limit)) {
    const t = new Date(h.timestamp).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    text +=
      `${h.status === "SENT" ? "✅" : "❌"} ${escapeHtml(h.giftName)} — ${h.price} ⭐\n` +
      `👤 ${escapeHtml(h.buyerLabel || String(h.buyerId))} → ${escapeHtml(h.recipientLabel || String(h.recipientId))}\n` +
      (h.text ? `💌 "${escapeHtml(h.text)}"\n` : "") +
      `🕒 ${t}\n\n`;
  }

  await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// /myorders — riwayat kirim gift milik user yang login
bot.onText(/^\/myorders(?:@\w+)?$/, async (msg) => {
  trackUser(msg.from);
  const mine = history
    .filter((h) => Number(h.buyerId) === msg.from.id)
    .slice(0, 10);

  if (!mine.length) {
    return sendBotMessage(msg.chat.id, "📭 Kamu belum pernah mengirim gift.");
  }

  await sendTyping(msg.chat.id);

  let text = `📜 <b>RIWAYAT KIRIM GIFT KAMU</b>\n\n`;
  for (const h of mine) {
    const t = new Date(h.timestamp).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    text +=
      `${h.status === "SENT" ? "✅" : "❌"} ${escapeHtml(h.giftName)} → ${escapeHtml(h.recipientLabel)}\n` +
      `💰 ${h.price} ⭐ • 🕒 ${t}\n\n`;
  }

  await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// /broadcast <pesan> (Owner Only)
bot.onText(/^\/broadcast(?:@\w+)? (.+)/, async (msg, match) => {
  trackUser(msg.from);
  if (!isOwner(msg.from.id)) {
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");
  }

  const textToBroadcast = match[1];
  let successCount = 0;
  let failCount = 0;

  await sendBotMessage(msg.chat.id, "📢 Memulai siaran...");

  for (const user of users.values()) {
    try {
      // Pesan siaran harus pesan BARU — jangan edit pesan lama di chat user
      await bot.sendMessage(
        user.id,
        `📢 <b>Pemberitahuan:</b>\n\n${escapeHtml(textToBroadcast)}`,
        {
          parse_mode: "HTML",
        },
      );
      successCount++;
    } catch {
      failCount++;
    }
    // FIX (#8): Jeda 100ms — lebih aman dari rate limit Telegram (~20-30 msg/detik)
    await new Promise((r) => setTimeout(r, 100));
  }

  sendBotMessage(
    msg.chat.id,
    `✅ <b>Siaran Selesai!</b>\n\n🟢 Berhasil: ${successCount}\n🔴 Gagal: ${failCount}`,
    { parse_mode: "HTML" },
  );
});

// /broadcast tanpa pesan — fallback
bot.onText(/^\/broadcast(?:@\w+)?$/, (msg) => {
  trackUser(msg.from);
  if (!isOwner(msg.from.id)) return;
  sendBotMessage(
    msg.chat.id,
    "⚠️ Gunakan format: <code>/broadcast &lt;pesan&gt;</code>",
    {
      parse_mode: "HTML",
    },
  );
});

// ==============================
// CALLBACK QUERY HANDLER
// ==============================

bot.on("callback_query", async (query) => {
  trackUser(query.from);
  const data = query.data;
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  await sendTyping(chatId);

  // MENU: LIHAT GIFT
  if (data === "menu:gifts") {
    await bot.answerCallbackQuery(query.id);
    try {
      const result = await getAvailableGifts();

      if (!result?.gifts?.length) {
        return sendBotMessage(
          chatId,
          "🎁 Saat ini tidak ada gift yang tersedia.",
        );
      }

      // FIX (#5): Sembunyikan gift limited edition yang belum dimiliki bot
      // (is_owned === false) — sendGift untuk gift seperti itu pasti gagal
      // dan berujung refund.
      const sendableGifts = result.gifts.filter((g) => g.is_owned !== false);

      if (!sendableGifts.length) {
        return sendBotMessage(
          chatId,
          "🎁 Saat ini tidak ada gift yang tersedia.",
        );
      }

      const buttons = sendableGifts.map((gift) => {
        const giftName = getGiftName(gift);
        const soldOutSoon =
          gift.remaining_count !== undefined && gift.remaining_count < 100
            ? " ⚠️"
            : "";

        return [
          {
            text: `${giftName} — ${gift.star_count} ⭐${soldOutSoon}`,
            callback_data: `select:${gift.id}`,
          },
        ];
      });

      await bot.editMessageText("🎁 <b>Pilih gift yang ingin kamu kirim:</b>", {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
      rememberBotMsg(chatId, query.message.message_id);
    } catch (err) {
      console.error(err.message);
      bot.answerCallbackQuery(query.id, {
        text: "Terjadi kesalahan.",
        show_alert: true,
      });
    }
    return;
  }

  // MENU: RIWAYAT SAYA
  if (data === "menu:myorders") {
    await bot.answerCallbackQuery(query.id);

    const mine = history
      .filter((h) => Number(h.buyerId) === userId)
      .slice(0, 10);

    let text;
    if (!mine.length) {
      text = "📭 Kamu belum pernah mengirim gift.";
    } else {
      text = `📜 <b>RIWAYAT KIRIM GIFT KAMU</b>\n\n`;
      for (const h of mine) {
        const t = new Date(h.timestamp).toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta",
        });
        text +=
          `${h.status === "SENT" ? "✅" : "❌"} ${escapeHtml(h.giftName)} → ${escapeHtml(h.recipientLabel)}\n` +
          `💰 ${h.price} ⭐ • 🕒 ${t}\n\n`;
      }
    }

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎁 Lihat Gift", callback_data: "menu:gifts" }],
          [{ text: "🏠 Menu Utama", callback_data: "menu:home" }],
        ],
      },
    });
    rememberBotMsg(chatId, query.message.message_id);
    return;
  }

  // MENU: HOME
  if (data === "menu:home") {
    await bot.answerCallbackQuery(query.id);
    const name =
      query.from.first_name ||
      (query.from.username ? `@${query.from.username}` : "kak");
    await bot.editMessageText(
      `👋 <b>Halo, ${escapeHtml(name)}!</b>\n\n` +
        `Selamat datang di <b>Nifz Gift Bot</b> 🎁\n` +
        `Kirim gift Telegram Stars ke temanmu dengan mudah dan cepat!\n\n` +
        `Silakan pilih menu di bawah ini:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎁 Lihat Gift", callback_data: "menu:gifts" }],
            [{ text: "📜 Riwayat Saya", callback_data: "menu:myorders" }],
            [{ text: "💝 Dukung Bot", callback_data: "menu:donate" }],
          ],
        },
      },
    );
    rememberBotMsg(chatId, query.message.message_id);
    return;
  }
  // MENU: DONATE
  if (data === "menu:donate") {
    await bot.answerCallbackQuery(query.id);

    const donateText =
      `💝 <b>Dukung Nifz Gift Bot</b>\n\n` +
      `Nifz Gift Bot dijalankan secara mandiri dan tidak mengambil pendapatan dari Stars yang digunakan untuk pembelian gift.\n\n` +
      `Jika kamu ingin membantu menjaga bot tetap online dan mendukung biaya operasionalnya, kamu bisa berdonasi melalui QRIS.\n\n` +
      `Donasi sepenuhnya sukarela.\n\n` +
      `Terima kasih atas dukungannya! ❤️`;

    await bot.editMessageText(donateText, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💳 Donasi via QRIS",
              url: "https://files.catbox.moe/w5sjnx.jpeg",
            },
          ],
          [
            {
              text: "🏠 Menu Utama",
              callback_data: "menu:home",
            },
          ],
        ],
      },
    });

    rememberBotMsg(chatId, query.message.message_id);
    return;
  }

  // SELECT GIFT
  if (data?.startsWith("select:")) {
    const giftId = data.split(":")[1];

    // FIX (#2): Jangan timpa order yang masih punya invoice aktif
    if (hasActivePaymentOrder(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: "Kamu masih punya invoice yang belum dibayar. Selesaikan dulu, atau ketik /cancel untuk membatalkan.",
        show_alert: true,
      });
    }

    try {
      const result = await getAvailableGifts(true); // force refresh agar stok akurat
      const gift = result?.gifts?.find((g) => String(g.id) === String(giftId));

      // FIX (#5): Verifikasi ulang gift benar-benar bisa dikirim
      if (!gift || gift.is_owned === false) {
        return bot.answerCallbackQuery(query.id, {
          text: "⚠️ Gift sudah tidak tersedia.",
          show_alert: true,
        });
      }

      const giftName = getGiftName(gift);

      setOrder(userId, {
        buyerId: userId,
        giftId: gift.id,
        giftName,
        price: gift.star_count,
        status: "WAITING_RECIPIENT",
        createdAt: Date.now(),
      });

      await bot.answerCallbackQuery(query.id);

      // Edit pesan daftar gift menjadi prompt penerima
      await bot.editMessageText(
        `🎁 <b>Gift Dipilih: ${escapeHtml(giftName)}</b>\n\n` +
          `💰 Harga: <b>${gift.star_count} ⭐</b>\n\n` +
          `Kirimkan username penerima (contoh: <code>@username_penerima</code>).\n\n` +
          `⚠️ <i>Penerima harus sudah pernah mengirim /start ke bot ini.</i>\n\n` +
          `Ketik /cancel untuk membatalkan.`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
        },
      );
      rememberBotMsg(chatId, query.message.message_id);
    } catch (err) {
      console.error(err.message);
      bot.answerCallbackQuery(query.id, {
        text: "Terjadi kesalahan.",
        show_alert: true,
      });
    }
    return;
  }

  // PAY
  if (data === "pay") {
    const order = orders.get(String(userId));

    if (!order) {
      return bot.answerCallbackQuery(query.id, {
        text: "Order tidak ditemukan atau sudah kedaluwarsa.",
        show_alert: true,
      });
    }

    if (order.status !== "WAITING_PAYMENT") {
      return bot.answerCallbackQuery(query.id, {
        text: "Order tidak dapat dibayar lagi.",
        show_alert: true,
      });
    }

    try {
      // FIX (#5): Cek ulang stok/harga gift tepat sebelum invoice dibuat
      const giftsResult = await getAvailableGifts(true);
      const gift = giftsResult?.gifts?.find(
        (g) => String(g.id) === String(order.giftId),
      );
      if (!gift || gift.is_owned === false) {
        return bot.answerCallbackQuery(query.id, {
          text: "Gift sudah tidak tersedia. Batalkan dengan /cancel lalu order ulang.",
          show_alert: true,
        });
      }
      if (gift.star_count !== order.price) {
        return bot.answerCallbackQuery(query.id, {
          text: "Harga gift berubah. Batalkan dengan /cancel lalu order ulang.",
          show_alert: true,
        });
      }

      const payload = `gift_${userId}_${order.giftId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      order.payload = payload;
      order.status = "PAYMENT_CREATED";
      setOrder(userId, order);

      await bot.answerCallbackQuery(query.id);

      // Hapus pesan summary sebelumnya, invoice tampil sebagai pesan baru
      await clearBotMessages(chatId);

      const invoiceMsg = await bot.sendInvoice(
        chatId,
        order.giftName,
        `Kirim gift ${order.giftName} ke ${order.recipientUsername}`,
        payload,
        "", // provider_token kosong untuk XTR (Stars)
        "XTR",
        [{ label: order.giftName, amount: order.price }],
      );
      rememberBotMsg(chatId, invoiceMsg.message_id);
    } catch (err) {
      console.error(err.message);
      bot.answerCallbackQuery(query.id, {
        text: "Gagal membuat invoice.",
        show_alert: true,
      });
    }
    return;
  }

  // PILIH TAMBAH PESAN
  if (data === "msg:add") {
    const order = orders.get(String(userId));

    if (!order || order.status !== "WAITING_MESSAGE_CHOICE") {
      return bot.answerCallbackQuery(query.id, {
        text: "Order tidak ditemukan atau sudah kedaluwarsa.",
        show_alert: true,
      });
    }

    order.status = "WAITING_TEXT";
    setOrder(userId, order);

    await bot.answerCallbackQuery(query.id);

    // Edit pesan pilihan menjadi prompt ketik pesan
    await bot.editMessageText(
      `💌 <b>Ketik pesan untuk gift-nya</b>\n\n` +
        `Maksimal <b>128 karakter</b>.\n\n` +
        `Ketik /cancel untuk membatalkan.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
      },
    );
    rememberBotMsg(chatId, query.message.message_id);
    return;
  }

  // PILIH TANPA PESAN
  if (data === "msg:skip") {
    const order = orders.get(String(userId));

    if (!order || order.status !== "WAITING_MESSAGE_CHOICE") {
      return bot.answerCallbackQuery(query.id, {
        text: "Order tidak ditemukan atau sudah kedaluwarsa.",
        show_alert: true,
      });
    }

    order.text = "";
    order.status = "WAITING_PAYMENT";
    setOrder(userId, order);

    await bot.answerCallbackQuery(query.id);
    await showOrderSummary(chatId, order, query.message.message_id);
    return;
  }
});

// ==============================
// TEXT INPUT HANDLER (RECEIVE USERNAME / PESAN GIFT)
// ==============================

bot.on("message", async (msg) => {
  trackUser(msg.from);

  // Abaikan command atau pesan non-teks
  if (!msg.text || msg.text.startsWith("/")) return;

  await sendTyping(msg.chat.id);

  const userId = msg.from.id;
  const order = orders.get(String(userId));

  if (
    !order ||
    (order.status !== "WAITING_RECIPIENT" && order.status !== "WAITING_TEXT")
  ) {
    return;
  }

  // ===== TAHAP: INPUT PESAN CUSTOM =====
  if (order.status === "WAITING_TEXT") {
    let giftText = msg.text.trim();
    if (giftText === "-") giftText = ""; // shortcut: "-" tetap berlaku sebagai tanpa pesan

    // Telegram membatasi text gift maksimal 128 karakter
    if (giftText.length > 128) {
      return sendBotMessage(
        msg.chat.id,
        `❌ Pesan terlalu panjang (<b>${giftText.length}</b> karakter). Maksimal <b>128 karakter</b>.\nCoba ketik ulang.`,
        { parse_mode: "HTML" },
      );
    }

    await deleteUserMessage(msg); // bersihkan input pesan dari chat

    order.text = giftText;
    order.status = "WAITING_PAYMENT";
    setOrder(userId, order);

    await showOrderSummary(msg.chat.id, order);
    return;
  }

  let usernameInput = msg.text.trim();
  if (!usernameInput.startsWith("@")) {
    usernameInput = `@${usernameInput}`;
  }

  if (!/^@[A-Za-z0-9_]{5,32}$/.test(usernameInput)) {
    return sendBotMessage(
      msg.chat.id,
      "❌ Format username tidak valid.\nContoh: <code>@username</code>",
      { parse_mode: "HTML" },
    );
  }

  const targetUsername = usernameInput.slice(1).toLowerCase();
  const recipient = [...users.values()].find(
    (u) => u.username === targetUsername,
  );

  if (!recipient) {
    return sendBotMessage(
      msg.chat.id,
      `❌ <b>Gagal menemukan user ${escapeHtml(usernameInput)}</b>\n\n` +
        `Akun tersebut harus sudah pernah mengirim /start ke bot ini.`,
      { parse_mode: "HTML" },
    );
  }

  await deleteUserMessage(msg); // bersihkan input username dari chat

  order.recipientId = recipient.id;
  order.recipientUsername = `@${recipient.username}`;
  order.status = "WAITING_MESSAGE_CHOICE";
  setOrder(userId, order);

  // Edit prompt username menjadi pilihan pesan
  await sendBotMessage(
    msg.chat.id,
    `💌 <b>Penerima: ${escapeHtml(order.recipientUsername)}</b>\n\n` +
      `Mau tambahkan pesan di gift-nya?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💌 Tambah Pesan", callback_data: "msg:add" },
            { text: "⏭️ Tanpa Pesan", callback_data: "msg:skip" },
          ],
        ],
      },
    },
  );
});

// ==============================
// PRE-CHECKOUT QUERY
// ==============================

bot.on("pre_checkout_query", async (query) => {
  trackUser(query.from);

  const order = [...orders.values()].find(
    (o) => o.payload === query.invoice_payload,
  );

  // Verifikasi pemilik + status order harus masih PAYMENT_CREATED
  // (mencegah invoice lama di-reuse setelah order selesai/diganti)
  if (
    !order ||
    Number(order.buyerId) !== query.from.id ||
    order.status !== "PAYMENT_CREATED"
  ) {
    return bot.answerPreCheckoutQuery(query.id, false, {
      error_message: "Order tidak ditemukan atau bukan milikmu.",
    });
  }

  if (query.currency !== "XTR") {
    return bot.answerPreCheckoutQuery(query.id, false, {
      error_message: "Mata uang tidak valid.",
    });
  }

  if (query.total_amount !== order.price) {
    return bot.answerPreCheckoutQuery(query.id, false, {
      error_message: "Harga gift telah berubah.",
    });
  }

  await bot.answerPreCheckoutQuery(query.id, true);
});

// ==============================
// SUCCESSFUL PAYMENT HANDLER
// ==============================

bot.on("message", async (msg) => {
  if (!msg.successful_payment) return;

  trackUser(msg.from);
  const payment = msg.successful_payment;
  const chatId = msg.chat.id;

  // FIX (#4): Idempotency — payload yang sudah berhasil diproses tidak
  // diproses ulang (Telegram bisa me-redeliver update setelah crash).
  if (processedPayloads.has(payment.invoice_payload)) {
    await bot.sendMessage(
      chatId,
      "✅ Pembayaran ini sudah diproses sebelumnya.",
    );
    return;
  }

  const order = [...orders.values()].find(
    (o) => o.payload === payment.invoice_payload,
  );

  // FIX (#1): Payload tidak dikenali — BISA JADI order terhapus cleanup.
  // Jangan cuma bilang ke user: alert owner untuk investigasi/refund manual.
  if (!order || Number(order.buyerId) !== msg.from.id) {
    console.error("Pembayaran tak dikenali:", JSON.stringify(payment));
    try {
      await bot.sendMessage(
        OWNER_ID,
        `🚨 <b>PEMBAYARAN TAK DIKENALI</b>\n\n` +
          `👤 Dari: <code>${msg.from.id}</code> ${escapeHtml(msg.from.username ? "@" + msg.from.username : "")}\n` +
          `🧾 Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
          `💰 Amount: ${payment.total_amount} ${escapeHtml(payment.currency)}\n\n` +
          `Kemungkinan order terhapus cleanup sebelum dibayar. CEK & REFUND MANUAL.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Gagal notif owner:", e.message);
    }
    return bot.sendMessage(
      chatId,
      "⚠️ Pembayaranmu sudah kami terima, tetapi data order-nya tidak ditemukan. Owner sudah diberitahu dan akan memproses pengiriman/refund. Simpan bukti pembayaran ini.",
    );
  }

  // FIX (#4): Order sudah PAID = sudah pernah masuk handler ini (mungkin
  // crash di tengah setelah sendGift). JANGAN kirim gift ulang — suruh owner verifikasi.
  if (order.status === "PAID") {
    console.error(
      "Redelivery successful_payment untuk order PAID:",
      payment.invoice_payload,
    );
    try {
      await bot.sendMessage(
        OWNER_ID,
        `⚠️ <b>UPDATE PEMBAYARAN ULANG</b>\n\n` +
          `Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
          `Buyer: <code>${order.buyerId}</code>\n\n` +
          `Gift TIDAK dikirim ulang. Verifikasi apakah gift sudah terkirim sebelumnya.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Gagal notif owner:", e.message);
    }
    return bot.sendMessage(
      chatId,
      "⚠️ Pembayaran ini sudah pernah diproses. Jika gift belum diterima, hubungi admin.",
    );
  }

  if (payment.total_amount !== order.price || payment.currency !== "XTR") {
    return bot.sendMessage(
      chatId,
      "⚠️ Nominal pembayaran tidak cocok dengan order. Hubungi admin.",
    );
  }

  // Tandai PAID SEBELUM kirim gift — jika proses mati di tengah,
  // order tetap tersimpan di disk dan bisa diinvestigasi owner
  order.status = "PAID";
  setOrder(order.buyerId, order);

  try {
    // Kirim Gift beserta pesan custom (jika ada)
    await sendGift(order.recipientId, order.giftId, order.text || "");

    const successText = order.text
      ? `💌 Pesan: <i>"${escapeHtml(order.text)}"</i>\n`
      : "";

    // FIX (#4): Tandai payload sebagai terproses SEBELUM menghapus order
    processedPayloads.add(payment.invoice_payload);

    // Catat ke riwayat (audit trail) sebelum order dihapus
    addHistory({
      payload: payment.invoice_payload,
      buyerId: msg.from.id,
      buyerLabel: msg.from.username
        ? `@${msg.from.username}`
        : msg.from.first_name || String(msg.from.id),
      recipientId: order.recipientId,
      recipientLabel: order.recipientUsername,
      giftId: order.giftId,
      giftName: order.giftName,
      price: order.price,
      text: order.text || "",
      status: "SENT",
      timestamp: Date.now(),
    });

    // Notif ke penerima gift
    try {
      const buyerName = msg.from.username
        ? `@${msg.from.username}`
        : msg.from.first_name || "seseorang";
      let notifText =
        `🎁 <b>Kamu menerima gift!</b>\n\n` +
        `🎁 ${escapeHtml(order.giftName)}\n` +
        `👤 Dari: ${escapeHtml(buyerName)}\n`;
      if (order.text) {
        notifText += `💌 Pesan: <i>"${escapeHtml(order.text)}"</i>\n`;
      }
      // Notif ke penerima harus pesan BARU di chat mereka
      await bot.sendMessage(order.recipientId, notifText, {
        parse_mode: "HTML",
      });
    } catch (e) {
      // Penerima mungkin blokir bot — gift tetap terkirim
      console.error("Gagal notif penerima:", e.message);
    }

    // FIX (#3): Pesan invoice TIDAK bisa di-edit oleh Telegram.
    // Kirim konfirmasi sebagai pesan BARU, bukan edit invoice.
    const confirmMsg = await bot.sendMessage(
      chatId,
      `✅ <b>Pembayaran & Pengiriman Berhasil!</b>\n\n` +
        `🎁 Gift: <b>${escapeHtml(order.giftName)}</b>\n` +
        `👤 Dikirim ke: ${escapeHtml(order.recipientUsername)}\n` +
        successText +
        `💰 Total: <b>${order.price} ⭐</b>`,
      { parse_mode: "HTML" },
    );
    rememberBotMsg(chatId, confirmMsg.message_id);
  } catch (err) {
    console.error("Gagal mengirim gift:", err.message);

    // Catat kegagalan ke riwayat (penting untuk refund/audit)
    addHistory({
      payload: payment.invoice_payload,
      buyerId: msg.from.id,
      buyerLabel: msg.from.username
        ? `@${msg.from.username}`
        : msg.from.first_name || String(msg.from.id),
      recipientId: order.recipientId,
      recipientLabel: order.recipientUsername,
      giftId: order.giftId,
      giftName: order.giftName,
      price: order.price,
      text: order.text || "",
      status: "FAILED",
      error: err.message,
      timestamp: Date.now(),
    });

    // FIX (#5 konsistensi): Pertahankan order FAILED 24 jam di orders.json
    // (untuk investigasi owner), lalu dihapus otomatis oleh cleanup interval.
    order.status = "FAILED";
    order.error = err.message;
    setOrder(order.buyerId, order);

    // Kirim notif ke owner untuk investigasi
    try {
      // Alert ke owner harus pesan BARU — alert lama tidak boleh ditimpa
      await bot.sendMessage(
        OWNER_ID,
        `🚨 <b>GIFT GAGAL TERKIRIM!</b>\n\n` +
          `👤 Buyer: <code>${order.buyerId}</code>\n` +
          `🎁 Gift: ${escapeHtml(order.giftName)}\n` +
          `📦 Recipient: ${escapeHtml(order.recipientUsername)} (<code>${order.recipientId}</code>)\n` +
          `💰 Amount: ${order.price} ⭐\n` +
          `🧾 Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
          `❌ Error: <code>${escapeHtml(err.message)}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Gagal notif owner:", e.message);
    }

    await bot.sendMessage(
      chatId,
      `❌ <b>Pembayaran diterima, tetapi gift gagal dikirim!</b>\n\n` +
        `Tim kami sudah diberitahu dan akan memproses pemeriksaan/refund.\n` +
        `Error: <code>${escapeHtml(err.message)}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Sukses penuh — baru hapus order dari map
  clearOrder(order.buyerId);
});

// ==============================
// AUTO-DELETE PESAN USER
// ==============================
// Handler ini didaftarkan TERAKHIR, jalan setelah semua handler lain selesai.
// Semua pesan teks user (input username / pesan gift) langsung dihapus
// supaya chat tidak menumpuk. Command (/) tetap disimpan sebagai jejak.

bot.on("message", (msg) => {
  // Pesan service (successful_payment, gift, dll) tidak punya text — tidak disentuh
  if (!msg.text) return;
  // Command (/) tetap disimpan sebagai jejak — yang dihapus cuma pesan input biasa
  if (msg.text.startsWith("/")) return;
  deleteUserMessage(msg);
});

// ==============================
// GLOBAL ERROR HANDLERS
// ==============================

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("SIGINT", () => {
  saveOrders();
  saveUsers();
  process.exit(0);
});

// ==============================
// BOT READY
// ==============================

console.log(
  `🤖 Nifz Gift Bot aktif. Users: ${users.size}, Orders tersimpan: ${orders.size}`,
);
