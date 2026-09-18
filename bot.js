const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ==============================
// CONFIG & ENVIRONMENT
// ==============================

const config = require("./config");

const {
  connectDB,
  getDB,
  closeDB,
  findUserById,
  findUserByUsername,
  upsertUser,
  findOrderByBuyerId,
  findOrderByPayload,
  upsertOrder,
  deleteOrder,
  getOrders,
  getOrdersByStatus,
  addHistory: addHistoryDB,
  findHistoryByPayload,
  updateHistoryByChargeId,
  getHistory,
  getHistoryByBuyerId,
  getSettings,
  updateSettings,
  setMaintenance,
  getStats,
} = require("./database");

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

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

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
// DATABASE CACHE
// ==============================

const orders = new Map();
const users = new Map();
const history = [];

let settings = {
  maintenance: false,
};

const processedPayloads = new Set();
const invoiceCreationLock = new Set();

async function addHistory(entry) {
  history.unshift(entry);

  if (history.length > 1000) {
    history.length = 1000;
  }

  await addHistoryDB(entry);
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

async function trackUser(from) {
  if (!from || from.is_bot) return;

  const key = String(from.id);
  const existing = users.get(key);

  const user = {
    id: from.id,
    username: from.username
      ? from.username.toLowerCase()
      : (existing?.username ?? null),
    first_name: from.first_name || (existing?.first_name ?? ""),
    updatedAt: Date.now(),
  };

  users.set(key, user);

  await upsertUser(user);
}

function getGiftName(gift) {
  if (GIFT_CUSTOM_NAMES[gift.id]) {
    return GIFT_CUSTOM_NAMES[gift.id];
  }
  const emoji = gift.sticker?.emoji ? `${gift.sticker.emoji} ` : "🎁";
  return `${emoji} Gift #${gift.id}`;
}

async function setOrder(userId, order) {
  orders.set(String(userId), order);
  await upsertOrder(order);
}

async function clearOrder(userId) {
  orders.delete(String(userId));
  await deleteOrder(userId);
}

function hasActivePaymentOrder(userId) {
  const o = orders.get(String(userId));
  return (
    o &&
    ["PAYMENT_CREATED", "PAID", "PROCESSING", "REFUNDING"].includes(o.status)
  );
}

// ==============================
// UI HELPERS — TYPING, EDIT & DELETE
// ==============================

async function sendTyping(chatId) {
  try {
    await bot.sendChatAction(chatId, "typing");
  } catch (_) {}
}

const lastBotMsg = new Map();
// Memori untuk menyimpan message_id command terakhir dari setiap user
const lastUserCommandMsg = new Map();

function rememberBotMsg(chatId, messageId) {
  lastBotMsg.set(String(chatId), { id: messageId, at: Date.now() });
}

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
    } catch (_) {}
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  rememberBotMsg(chatId, sent.message_id);
  return sent.message_id;
}

async function clearBotMessages(chatId) {
  const last = lastBotMsg.get(String(chatId));
  if (last) {
    try {
      await bot.deleteMessage(chatId, last.id);
    } catch (_) {}
    lastBotMsg.delete(String(chatId));
  }
}

async function deleteUserMessage(msg) {
  try {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
  } catch (_) {}
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

async function refundStarPayment(userId, chargeId) {
  return telegramApi("refundStarPayment", {
    user_id: Number(userId),
    telegram_payment_charge_id: chargeId,
  });
}

// ==============================
// CLEANUP & AUTOSAVE
// ==============================

// Cleanup yang tidak menghapus status FAILED, REFUNDING, REFUND_FAILED yang belum aman
setInterval(
  async () => {
    const now = Date.now();

    for (const [userId, order] of orders.entries()) {
      if (!order.createdAt) continue;

      if (
        ["SENT", "REFUNDED"].includes(order.status) &&
        now - order.createdAt > 2 * 60 * 60 * 1000
      ) {
        orders.delete(userId);
        await deleteOrder(userId);
      } else if (
        order.status === "PAYMENT_CREATED" &&
        now - order.createdAt > 24 * 60 * 60 * 1000
      ) {
        orders.delete(userId);
        await deleteOrder(userId);
      }
    }
  },
  5 * 60 * 1000,
);

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

  if (editMessageId) {
    try {
      await bot.editMessageText(summaryText, {
        chat_id: chatId,
        message_id: editMessageId,
        ...options,
      });
      rememberBotMsg(chatId, editMessageId);
      return;
    } catch (_) {}
  }

  await sendBotMessage(chatId, summaryText, options);
}

// ==============================
// MAINTENANCE GUARD HELPER
// ==============================

function isMaintenanceActive(userId) {
  return settings.maintenance && !isOwner(userId);
}

function sendMaintenanceMsg(chatId) {
  return sendBotMessage(
    chatId,
    `🛠️ <b>Nifz Gift Bot sedang maintenance.</b>\n\nSilakan coba lagi nanti.`,
    { parse_mode: "HTML" },
  );
}

// ==============================
// BOT COMMANDS
// ==============================

// /start
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (hasActivePaymentOrder(userId)) {
    return sendBotMessage(
      chatId,
      "⚠️ Kamu masih punya order/invoice yang sedang berjalan.\nSelesaikan pembayaran, atau ketik /cancel untuk membatalkan.",
      { parse_mode: "HTML" },
    );
  }

  await clearOrder(userId);
  await sendTyping(chatId);

  const name =
    msg.from.first_name ||
    (msg.from.username ? `@${msg.from.username}` : "kak");

  let maintenanceNotice = "";
  if (settings.maintenance) {
    maintenanceNotice =
      "\n\n⚠️ <i>Bot sedang dalam mode maintenance. Pembuatan order baru dinonaktifkan sementara.</i>";
  }

  await sendBotMessage(
    chatId,
    `👋 <b>Halo, ${escapeHtml(name)}!</b>\n\n` +
      `Selamat datang di <b>Nifz Gift Bot</b> 🎁\n` +
      `Kirim gift Telegram Stars ke temanmu dengan mudah dan cepat!${maintenanceNotice}\n\n` +
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
  await trackUser(msg.from);
  const userId = msg.from.id;
  const order = orders.get(String(userId));

  if (!order) {
    return sendBotMessage(msg.chat.id, "Tidak ada order yang sedang berjalan.");
  }

  if (["PAID", "PROCESSING", "REFUNDING"].includes(order.status)) {
    return sendBotMessage(
      msg.chat.id,
      "⚠️ Pembayaranmu sedang diproses. Order tidak dapat dibatalkan saat ini.",
      { parse_mode: "HTML" },
    );
  }

  const hadInvoice = order.status === "PAYMENT_CREATED";
  await clearOrder(userId);
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

// /myorders
bot.onText(/^\/myorders(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  const mine = history
    .filter((h) => Number(h.buyerId) === msg.from.id)
    .slice(0, 10);

  if (!mine.length) {
    return sendBotMessage(msg.chat.id, "📭 Kamu belum pernah mengirim gift.");
  }

  await sendTyping(msg.chat.id);

  let text = `📜 <b>RIWAYAT KIRIM GIFT KAMU</b>\n\n`;
  for (const h of mine) {
    const t = new Date(h.timestamp || h.createdAt || Date.now()).toLocaleString(
      "id-ID",
      {
        timeZone: "Asia/Jakarta",
      },
    );
    const statusIcon =
      h.status === "SENT"
        ? "✅"
        : h.status === "REFUNDED"
          ? "⭐ (Refunded)"
          : "❌";
    text +=
      `${statusIcon} ${escapeHtml(h.giftName)} → ${escapeHtml(h.recipientLabel || String(h.recipientId))}\n` +
      `💰 ${h.price} ⭐ • 🕒 ${t}\n\n`;
  }

  await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// OWNER COMMAND: /maintenance
bot.onText(/^\/maintenance(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  settings.maintenance = !settings.maintenance;
  await setMaintenance(settings.maintenance);

  const statusText = settings.maintenance
    ? "🔴 Maintenance sekarang: ON"
    : "🟢 Maintenance sekarang: OFF";
  console.log(`[ORDER] Owner toggled maintenance: ${settings.maintenance}`);
  return sendBotMessage(
    msg.chat.id,
    `🛠️ <b>MAINTENANCE MODE</b>\n\n${statusText}`,
    { parse_mode: "HTML" },
  );
});

// OWNER COMMAND: /balance
bot.onText(/^\/balance(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  await sendTyping(msg.chat.id);
  try {
    const me = await telegramApi("getMe");
    // Gunakan getMyStarBalance atau fallback jika ketersediaan API berbeda
    const result = await telegramApi("getMyStarBalance").catch(async () => {
      return await telegramApi("getStarTransactions", { offset: 0, limit: 1 });
    });

    let balanceStr = "N/A";
    if (typeof result === "number") {
      balanceStr = result.toLocaleString("id-ID");
    } else if (result && result.amount !== undefined) {
      balanceStr = Number(result.amount).toLocaleString("id-ID");
    } else if (result && result.star_count !== undefined) {
      balanceStr = Number(result.star_count).toLocaleString("id-ID");
    }

    await sendBotMessage(
      msg.chat.id,
      `⭐ <b>SALDO NIFZ GIFT BOT</b>\n\n💰 Balance: <b>${balanceStr} ⭐</b>`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    console.error(`[ERROR /balance] ${err.message}`);
    sendBotMessage(
      msg.chat.id,
      `❌ Gagal mengambil saldo Stars.\n\nError: ${escapeHtml(err.message)}`,
    );
  }
});

// OWNER COMMAND: /transactions
bot.onText(/^\/transactions(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  await sendTyping(msg.chat.id);
  try {
    const data = await getStarTransactions(0, 20);
    const transactions = data?.transactions || [];

    if (!transactions.length) {
      return sendBotMessage(msg.chat.id, "📭 Belum ada transaksi Stars.");
    }

    let text = "📊 <b>TRANSAKSI STARS</b>\n\n";
    for (const tx of transactions) {
      const sign = tx.amount >= 0 ? "+" : "";
      const partner = tx.source?.type || tx.receiver?.type || "transaction";
      const dateStr = new Date(
        (tx.date || Date.now() / 1000) * 1000,
      ).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      text += `⭐ ${sign}${tx.amount}\n🔹 Type: ${escapeHtml(partner)}\n🆔 ID: <code>${escapeHtml(tx.id || "-")}</code>\n🕒 Date: ${dateStr}\n\n`;
    }

    await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
  } catch (err) {
    logError(`Error /transactions: ${err.message}`);
    sendBotMessage(
      msg.chat.id,
      `❌ Gagal mengambil transaksi.\n\nError: ${escapeHtml(err.message)}`,
    );
  }
});

// OWNER COMMAND: /stats
bot.onText(/^\/stats(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  const stats = await getStats();

  const totalUsers = stats.users;
  const totalOrders = stats.history;

  const successOrders = history.filter((h) => h.status === "SENT");
  const failedOrders = history.filter(
    (h) =>
      h.status === "FAILED" ||
      h.status === "REFUNDED" ||
      h.status === "REFUND_FAILED",
  );

  const totalStars = successOrders.reduce(
    (acc, curr) => acc + (Number(curr.price) || 0),
    0,
  );
  const totalRefunds = history
    .filter((h) => h.status === "REFUNDED" || h.refundStatus === "REFUNDED")
    .reduce((acc, curr) => acc + (Number(curr.price) || 0), 0);

  // Hitung gift paling sering dikirim
  const giftCounts = {};
  for (const h of successOrders) {
    const gName = h.giftName || "Gift Unknown";
    giftCounts[gName] = (giftCounts[gName] || 0) + 1;
  }

  let topGiftsText = "-";
  const sortedGifts = Object.entries(giftCounts).sort((a, b) => b[1] - a[1]);
  if (sortedGifts.length > 0) {
    topGiftsText = sortedGifts
      .slice(0, 3)
      .map(([name, count]) => `${escapeHtml(name)} — ${count}x`)
      .join("\n");
  }

  sendBotMessage(
    msg.chat.id,
    `📈 <b>STATISTIK NIFZ GIFT BOT</b>\n\n` +
      `👥 Total User: <b>${totalUsers}</b>\n\n` +
      `📦 Total Order: <b>${totalOrders}</b>\n\n` +
      `✅ Gift Terkirim: <b>${successOrders.length}</b>\n` +
      `❌ Gift Gagal: <b>${failedOrders.length}</b>\n\n` +
      `⭐ Total Stars dari Order: <b>${totalStars.toLocaleString("id-ID")} ⭐</b>\n\n` +
      `💸 Total Refund: <b>${totalRefunds.toLocaleString("id-ID")} ⭐</b>\n\n` +
      `🎁 Gift Paling Banyak Dikirim:\n${topGiftsText}`,
    { parse_mode: "HTML" },
  );
});

// OWNER COMMAND: /orders
bot.onText(/^\/orders(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  const limit = Math.min(Math.max(Number(match[1] || 10), 1), 50);

  if (!history.length) {
    return sendBotMessage(msg.chat.id, "📭 Belum ada riwayat order.");
  }

  await sendTyping(msg.chat.id);

  let text = `📜 <b>RIWAYAT ORDER TERAKHIR (${Math.min(limit, history.length)})</b>\n\n`;
  for (const h of history.slice(0, limit)) {
    const t = new Date(h.timestamp || h.createdAt || Date.now()).toLocaleString(
      "id-ID",
      {
        timeZone: "Asia/Jakarta",
      },
    );
    const statusIcon =
      h.status === "SENT" ? "✅" : h.status === "REFUNDED" ? "⭐" : "❌";
    text +=
      `${statusIcon} <b>${escapeHtml(h.giftName)}</b> — ${h.price} ⭐ [<code>${h.status}</code>]\n` +
      `👤 ${escapeHtml(h.buyerLabel || String(h.buyerId))} → ${escapeHtml(h.recipientLabel || String(h.recipientId))}\n` +
      `🧾 Payload: <code>${escapeHtml(h.payload || "-")}</code>\n` +
      `🕒 ${t}\n\n`;
  }

  await sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// OWNER COMMAND: /order <payload>
bot.onText(/^\/order(?:@\w+)?\s+(.+)$/, async (msg, match) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  const payloadTarget = match[1].trim();

  // Cari di active orders dulu
  let item = [...orders.values()].find((o) => o.payload === payloadTarget);
  // Jika tidak ada, cari di history
  if (!item) {
    item = history.find((h) => h.payload === payloadTarget);
  }

  if (!item) {
    return sendBotMessage(msg.chat.id, "❌ Order tidak ditemukan.");
  }

  const timeStr = new Date(
    item.timestamp || item.createdAt || Date.now(),
  ).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
  });

  const text =
    `📦 <b>DETAIL ORDER</b>\n\n` +
    `👤 Buyer: ${escapeHtml(item.buyerLabel || "-")}\n` +
    `🆔 Buyer ID: <code>${item.buyerId}</code>\n\n` +
    `🎁 Gift: ${escapeHtml(item.giftName)}\n` +
    `🆔 Gift ID: <code>${item.giftId}</code>\n\n` +
    `👤 Recipient: ${escapeHtml(item.recipientLabel || item.recipientUsername || "-")}\n` +
    `🆔 Recipient ID: <code>${item.recipientId || "-"}</code>\n\n` +
    `💰 Harga: ${item.price} ⭐\n\n` +
    `📌 Status: <b>${item.status}</b>\n\n` +
    `💳 Charge ID: <code>${escapeHtml(item.telegramPaymentChargeId || "-")}</code>\n` +
    `🧾 Payload: <code>${escapeHtml(item.payload || "-")}</code>\n\n` +
    `💌 Pesan: <i>"${escapeHtml(item.text || "-")}"</i>\n\n` +
    `🕒 Waktu: ${timeStr}`;

  sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// OWNER COMMAND: /recovery
bot.onText(/^\/recovery(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  const needsRecovery = [...orders.values()].filter((o) =>
    ["PAID", "PROCESSING", "FAILED", "REFUNDING", "REFUND_FAILED"].includes(
      o.status,
    ),
  );

  if (!needsRecovery.length) {
    return sendBotMessage(
      msg.chat.id,
      "✅ Tidak ada order yang membutuhkan recovery.",
    );
  }

  let text = `🚨 <b>ORDER PERLU RECOVERY</b>\n\n`;
  needsRecovery.forEach((o, index) => {
    text +=
      `${index + 1}. 🎁 <b>${escapeHtml(o.giftName)}</b>\n` +
      `👤 Buyer: <code>${o.buyerId}</code>\n` +
      `👤 Recipient: ${escapeHtml(o.recipientUsername || String(o.recipientId))}\n` +
      `⭐ Amount: ${o.price}\n` +
      `💳 Charge ID: <code>${escapeHtml(o.telegramPaymentChargeId || "-")}</code>\n` +
      `📌 Status: <b>${o.status}</b>\n\n`;
  });

  sendBotMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// OWNER COMMAND: /refund <user_id> <charge_id>
bot.onText(
  /^\/refund(?:@\w+)?(?:\s+(\d+))?(?:\s+(.+))?$/,
  async (msg, match) => {
    await trackUser(msg.from);
    if (!isOwner(msg.from.id))
      return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

    const targetUserId = match[1];
    const targetChargeId = match[2]?.trim();

    if (!targetUserId || !targetChargeId) {
      return sendBotMessage(
        msg.chat.id,
        "⚠️ Format salah.\nGunakan: <code>/refund &lt;user_id&gt; &lt;charge_id&gt;</code>",
        { parse_mode: "HTML" },
      );
    }

    // Cek apakah sudah pernah direfund
    const alreadyRefunded = history.some(
      (h) =>
        h.telegramPaymentChargeId === targetChargeId &&
        (h.status === "REFUNDED" || h.refundStatus === "REFUNDED"),
    );

    if (alreadyRefunded) {
      return sendBotMessage(
        msg.chat.id,
        `⚠️ <b>REFUND DITOLAK</b>\n\nCharge ID <code>${escapeHtml(targetChargeId)}</code> sudah pernah di-refund sebelumnya.`,
        { parse_mode: "HTML" },
      );
    }

    await sendTyping(msg.chat.id);
    console.log(
      `Owner initiating manual refund for user ${targetUserId}, charge ${targetChargeId}`,
    );

    try {
      await refundStarPayment(targetUserId, targetChargeId);

      // Update status di orders & history
      for (const [uid, ord] of orders.entries()) {
        if (
          ord.telegramPaymentChargeId === targetChargeId ||
          String(ord.buyerId) === String(targetUserId)
        ) {
          ord.status = "REFUNDED";
          ord.refundStatus = "REFUNDED";
          await setOrder(uid, ord);
        }
      }

      let hItem = history.find(
        (h) => h.telegramPaymentChargeId === targetChargeId,
      );

      if (hItem) {
        hItem.status = "REFUNDED";
        hItem.refundStatus = "REFUNDED";

        await updateHistoryByChargeId(targetChargeId, {
          status: "REFUNDED",
          refundStatus: "REFUNDED",
        });
      } else {
        await addHistory({
          payload: `manual_refund_${Date.now()}`,
          buyerId: Number(targetUserId),
          buyerLabel: String(targetUserId),
          giftName: "Manual Refund",
          price: 0,
          status: "REFUNDED",
          refundStatus: "REFUNDED",
          telegramPaymentChargeId: targetChargeId,
          timestamp: Date.now(),
        });
      }

      sendBotMessage(
        msg.chat.id,
        `✅ <b>REFUND BERHASIL</b>\n\n` +
          `👤 User: <code>${targetUserId}</code>\n` +
          `💳 Charge ID: <code>${escapeHtml(targetChargeId)}</code>\n` +
          `⭐ Stars telah dikembalikan.`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logError(`Refund manual failed: ${err.message}`);
      sendBotMessage(
        msg.chat.id,
        `❌ <b>REFUND GAGAL</b>\n\nError: <code>${escapeHtml(err.message)}</code>`,
        { parse_mode: "HTML" },
      );
    }
  },
);

// OWNER COMMAND: /broadcast
bot.onText(/^\/broadcast(?:@\w+)?\s+(.+)$/, async (msg, match) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id))
    return sendBotMessage(msg.chat.id, "❌ Command ini khusus owner.");

  const textToBroadcast = match[1];
  let successCount = 0;
  let failCount = 0;

  const statusMsgId = await sendBotMessage(msg.chat.id, "📢 Memulai siaran...");
  const userList = [...users.values()];

  for (let i = 0; i < userList.length; i++) {
    const u = userList[i];
    try {
      await bot.sendMessage(
        u.id,
        `📢 <b>Pemberitahuan:</b>\n\n${escapeHtml(textToBroadcast)}`,
        { parse_mode: "HTML" },
      );
      successCount++;
    } catch (_) {
      failCount++;
    }

    // Update progress tiap 10 user agar owner mendapat info tanpa spamming
    if ((i + 1) % 10 === 0 || i === userList.length - 1) {
      try {
        await bot.editMessageText(
          `📢 <b>Memproses Siaran...</b> (${i + 1}/${userList.length})\n\n` +
            `🟢 Berhasil: ${successCount}\n` +
            `🔴 Gagal: ${failCount}`,
          { chat_id: msg.chat.id, message_id: statusMsgId, parse_mode: "HTML" },
        );
      } catch (_) {}
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  sendBotMessage(
    msg.chat.id,
    `✅ <b>Siaran Selesai!</b>\n\n🟢 Berhasil: ${successCount}\n🔴 Gagal: ${failCount}`,
    { parse_mode: "HTML" },
  );
});

bot.onText(/^\/broadcast(?:@\w+)?$/, async (msg) => {
  await trackUser(msg.from);
  if (!isOwner(msg.from.id)) return;
  sendBotMessage(
    msg.chat.id,
    "⚠️ Gunakan format: <code>/broadcast &lt;pesan&gt;</code>",
    { parse_mode: "HTML" },
  );
});

// ==============================
// CALLBACK QUERY HANDLER
// ==============================

bot.on("callback_query", async (query) => {
  await trackUser(query.from);
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
      logError(`Error callback menu:gifts: ${err.message}`);
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
        const t = new Date(
          h.timestamp || h.createdAt || Date.now(),
        ).toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta",
        });
        const statusIcon =
          h.status === "SENT" ? "✅" : h.status === "REFUNDED" ? "⭐" : "❌";
        text +=
          `${statusIcon} ${escapeHtml(h.giftName)} → ${escapeHtml(h.recipientLabel || String(h.recipientId))}\n` +
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
          [{ text: "🏠 Menu Utama", callback_data: "menu:home" }],
        ],
      },
    });
    rememberBotMsg(chatId, query.message.message_id);
    return;
  }

  // SELECT GIFT
  if (data?.startsWith("select:")) {
    if (isMaintenanceActive(userId)) {
      await bot.answerCallbackQuery(query.id);
      return sendMaintenanceMsg(chatId);
    }

    const giftId = data.split(":")[1];

    if (hasActivePaymentOrder(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: "Kamu masih punya invoice/order aktif. Selesaikan dulu, atau ketik /cancel untuk membatalkan.",
        show_alert: true,
      });
    }

    try {
      const result = await getAvailableGifts(true);
      const gift = result?.gifts?.find((g) => String(g.id) === String(giftId));

      if (!gift || gift.is_owned === false) {
        return bot.answerCallbackQuery(query.id, {
          text: "⚠️ Gift sudah tidak tersedia.",
          show_alert: true,
        });
      }

      const giftName = getGiftName(gift);

      await setOrder(userId, {
        buyerId: userId,
        giftId: gift.id,
        giftName,
        price: gift.star_count,
        status: "WAITING_RECIPIENT",
        createdAt: Date.now(),
      });

      await bot.answerCallbackQuery(query.id);

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
      logError(`Error select gift: ${err.message}`);
      bot.answerCallbackQuery(query.id, {
        text: "Terjadi kesalahan.",
        show_alert: true,
      });
    }
    return;
  }

  // PAY
  if (data === "pay") {
    if (isMaintenanceActive(userId)) {
      await bot.answerCallbackQuery(query.id);
      return sendMaintenanceMsg(chatId);
    }

    // Double-click lock
    if (invoiceCreationLock.has(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: "Sedang membuat invoice, harap tunggu...",
        show_alert: true,
      });
    }

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

    invoiceCreationLock.add(userId);

    try {
      const giftsResult = await getAvailableGifts(true);
      const gift = giftsResult?.gifts?.find(
        (g) => String(g.id) === String(order.giftId),
      );

      if (!gift || gift.is_owned === false) {
        invoiceCreationLock.delete(userId);
        return bot.answerCallbackQuery(query.id, {
          text: "Gift sudah tidak tersedia. Batalkan dengan /cancel lalu order ulang.",
          show_alert: true,
        });
      }

      if (gift.star_count !== order.price) {
        invoiceCreationLock.delete(userId);
        return bot.answerCallbackQuery(query.id, {
          text: "Harga gift berubah. Batalkan dengan /cancel lalu order ulang.",
          show_alert: true,
        });
      }

      const payload = `gift_${userId}_${order.giftId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      order.payload = payload;
      order.status = "PAYMENT_CREATED";
      await setOrder(userId, order);

      await bot.answerCallbackQuery(query.id);
      await clearBotMessages(chatId);

      const invoiceMsg = await bot.sendInvoice(
        chatId,
        order.giftName,
        `Kirim gift ${order.giftName} ke ${order.recipientUsername}`,
        payload,
        "",
        "XTR",
        [{ label: order.giftName, amount: order.price }],
      );

      rememberBotMsg(chatId, invoiceMsg.message_id);
      console.log(
        `[PAYMENT] Invoice created for user ${userId}, payload: ${payload}`,
      );
    } catch (err) {
      logError(`Gagal create invoice: ${err.message}`);
      bot.answerCallbackQuery(query.id, {
        text: "Gagal membuat invoice.",
        show_alert: true,
      });
    } finally {
      invoiceCreationLock.delete(userId);
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
    await setOrder(userId, order);

    await bot.answerCallbackQuery(query.id);

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
    await setOrder(userId, order);

    await bot.answerCallbackQuery(query.id);
    await showOrderSummary(chatId, order, query.message.message_id);
    return;
  }
});

// ==============================
// TEXT INPUT HANDLER
// ==============================

bot.on("message", async (msg) => {
  await trackUser(msg.from);

  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const order = orders.get(String(userId));

  if (!order || !["WAITING_RECIPIENT", "WAITING_TEXT"].includes(order.status)) {
    return;
  }

  await sendTyping(msg.chat.id);

  // INPUT PESAN CUSTOM
  if (order.status === "WAITING_TEXT") {
    let giftText = msg.text.trim();
    if (giftText === "-") giftText = "";

    if (giftText.length > 128) {
      return sendBotMessage(
        msg.chat.id,
        `❌ Pesan terlalu panjang (<b>${giftText.length}</b> karakter). Maksimal <b>128 karakter</b>.\nCoba ketik ulang.`,
        { parse_mode: "HTML" },
      );
    }

    await deleteUserMessage(msg);

    order.text = giftText;
    order.status = "WAITING_PAYMENT";
    await setOrder(userId, order);

    await showOrderSummary(msg.chat.id, order);
    return;
  }

  // INPUT RECIPIENT
  if (order.status === "WAITING_RECIPIENT") {
    if (isMaintenanceActive(userId)) {
      return sendMaintenanceMsg(msg.chat.id);
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
    const recipient = await findUserByUsername(targetUsername);

    if (!recipient) {
      return sendBotMessage(
        msg.chat.id,
        `❌ <b>Gagal menemukan user ${escapeHtml(usernameInput)}</b>\n\n` +
          `Akun tersebut harus sudah pernah mengirim /start ke bot ini.`,
        { parse_mode: "HTML" },
      );
    }

    await deleteUserMessage(msg);

    order.recipientId = recipient.id;
    order.recipientUsername = `@${recipient.username}`;
    order.status = "WAITING_MESSAGE_CHOICE";
    await setOrder(userId, order);

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
    return;
  }
});

// ==============================
// PRE-CHECKOUT QUERY
// ==============================

bot.on("pre_checkout_query", async (query) => {
  await trackUser(query.from);

  const order = [...orders.values()].find(
    (o) => o.payload === query.invoice_payload,
  );

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

  await trackUser(msg.from);
  const payment = msg.successful_payment;
  const chatId = msg.chat.id;
  const chargeId = payment.telegram_payment_charge_id;

  console.log(
    `[PAYMENT] Successful payment received. Payload: ${payment.invoice_payload}, Charge ID: ${chargeId}`,
  );

  // Protection duplicate payload
  if (processedPayloads.has(payment.invoice_payload)) {
    return bot.sendMessage(
      chatId,
      "✅ Pembayaran ini sudah diproses sebelumnya.",
    );
  }

  let order = [...orders.values()].find(
    (o) => o.payload === payment.invoice_payload,
  );

  if (!order || Number(order.buyerId) !== msg.from.id) {
    logError(`Pembayaran tidak dikenali. Payload: ${payment.invoice_payload}`);
    try {
      await bot.sendMessage(
        OWNER_ID,
        `🚨 <b>PEMBAYARAN TAK DIKENALI</b>\n\n` +
          `👤 Dari: <code>${msg.from.id}</code> ${escapeHtml(msg.from.username ? "@" + msg.from.username : "")}\n` +
          `🧾 Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
          `💳 Charge ID: <code>${escapeHtml(chargeId || "-")}</code>\n` +
          `💰 Amount: ${payment.total_amount} ${escapeHtml(payment.currency)}\n\n` +
          `Data order tidak ditemukan di sistem. CEK & REFUND MANUAL.`,
        { parse_mode: "HTML" },
      );
    } catch (_) {}
    return bot.sendMessage(
      chatId,
      "⚠️ Pembayaranmu sudah kami terima, tetapi data order-nya tidak ditemukan. Admin telah diberitahu.",
    );
  }

  if (
    order.status === "PAID" ||
    order.status === "PROCESSING" ||
    order.status === "SENT"
  ) {
    return bot.sendMessage(chatId, "⚠️ Pembayaran ini sudah pernah diproses.");
  }

  if (payment.total_amount !== order.price || payment.currency !== "XTR") {
    return bot.sendMessage(
      chatId,
      "⚠️ Nominal pembayaran tidak cocok dengan order.",
    );
  }

  // Update order status & simpan charge ID
  order.telegramPaymentChargeId = chargeId;
  order.status = "PAID";
  await setOrder(order.buyerId, order);

  order.status = "PROCESSING";
  await setOrder(order.buyerId, order);

  try {
    // Eksekusi Pengiriman Gift
    await sendGift(order.recipientId, order.giftId, order.text || "");

    order.status = "SENT";
    await setOrder(order.buyerId, order);
    processedPayloads.add(payment.invoice_payload);

    await addHistory({
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
      telegramPaymentChargeId: chargeId,
      createdAt: order.createdAt,
      timestamp: Date.now(),
    });

    console.log(
      `[ORDER] Gift sent successfully. Payload: ${payment.invoice_payload}`,
    );

    // Notifikasi Penerima
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
      await bot.sendMessage(order.recipientId, notifText, {
        parse_mode: "HTML",
      });
    } catch (e) {
      logError(`Gagal kirim notif penerima: ${e.message}`);
    }

    // Konfirmasi Buyer
    const successText = order.text
      ? `💌 Pesan: <i>"${escapeHtml(order.text)}"</i>\n`
      : "";
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
    await clearOrder(order.buyerId);
  } catch (err) {
    logError(
      `sendGift failed for payload ${payment.invoice_payload}: ${err.message}`,
    );

    order.status = "FAILED";
    order.error = err.message;
    await setOrder(order.buyerId, order);

    // AUTO REFUND ATTEMPT
    order.status = "REFUNDING";
    await setOrder(order.buyerId, order);

    let refundSuccess = false;
    let refundErrorMsg = "";

    try {
      if (chargeId) {
        await refundStarPayment(order.buyerId, chargeId);
        refundSuccess = true;
      } else {
        refundErrorMsg = "Charge ID tidak tersedia";
      }
    } catch (rErr) {
      refundErrorMsg = rErr.message;
    }

    if (refundSuccess) {
      order.status = "REFUNDED";
      order.refundStatus = "REFUNDED";
      await setOrder(order.buyerId, order);
      processedPayloads.add(payment.invoice_payload);

      await addHistory({
        payload: payment.invoice_payload,
        buyerId: msg.from.id,
        buyerLabel: msg.from.username
          ? `@${msg.from.username}`
          : String(msg.from.id),
        recipientId: order.recipientId,
        recipientLabel: order.recipientUsername,
        giftId: order.giftId,
        giftName: order.giftName,
        price: order.price,
        text: order.text || "",
        status: "FAILED",
        error: err.message,
        refundStatus: "REFUNDED",
        telegramPaymentChargeId: chargeId,
        createdAt: order.createdAt,
        timestamp: Date.now(),
      });

      console.log(`[REFUND] Auto-refund successful for charge ID ${chargeId}`);

      // Owner Notification
      try {
        await bot.sendMessage(
          OWNER_ID,
          `🚨 <b>GIFT GAGAL TERKIRIM (AUTO-REFUND BERHASIL)</b>\n\n` +
            `👤 Buyer: <code>${order.buyerId}</code>\n` +
            `🎁 Gift: ${escapeHtml(order.giftName)}\n` +
            `📦 Recipient: ${escapeHtml(order.recipientUsername)}\n` +
            `💰 Amount: ${order.price} ⭐\n` +
            `🧾 Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
            `💳 Charge ID: <code>${escapeHtml(chargeId)}</code>\n\n` +
            `❌ Error: <code>${escapeHtml(err.message)}</code>\n` +
            `💸 Refund: <b>SUCCESS</b>`,
          { parse_mode: "HTML" },
        );
      } catch (_) {}

      // User Notification
      await bot.sendMessage(
        chatId,
        `❌ <b>Gift gagal dikirim.</b>\n\n` +
          `Pembayaran kamu sudah dikembalikan otomatis.\n` +
          `⭐ Refund: <b>Berhasil</b>\n\n` +
          `Jika Stars belum terlihat, tunggu beberapa saat.`,
        { parse_mode: "HTML" },
      );
    } else {
      order.status = "REFUND_FAILED";
      order.refundStatus = "REFUND_FAILED";
      order.refundError = refundErrorMsg;
      await setOrder(order.buyerId, order);

      await addHistory({
        payload: payment.invoice_payload,
        buyerId: msg.from.id,
        buyerLabel: msg.from.username
          ? `@${msg.from.username}`
          : String(msg.from.id),
        recipientId: order.recipientId,
        recipientLabel: order.recipientUsername,
        giftId: order.giftId,
        giftName: order.giftName,
        price: order.price,
        text: order.text || "",
        status: "FAILED",
        error: err.message,
        refundStatus: "REFUND_FAILED",
        refundError: refundErrorMsg,
        telegramPaymentChargeId: chargeId,
        createdAt: order.createdAt,
        timestamp: Date.now(),
      });

      console.error(
        `[REFUND ERROR] Auto-refund failed for charge ID ${chargeId}: ${refundErrorMsg}`,
      );

      // Owner Notification
      try {
        await bot.sendMessage(
          OWNER_ID,
          `🚨 <b>GIFT GAGAL TERKIRIM & REFUND GAGAL!</b>\n\n` +
            `👤 Buyer: <code>${order.buyerId}</code>\n` +
            `🎁 Gift: ${escapeHtml(order.giftName)}\n` +
            `📦 Recipient: ${escapeHtml(order.recipientUsername)}\n` +
            `💰 Amount: ${order.price} ⭐\n` +
            `🧾 Payload: <code>${escapeHtml(payment.invoice_payload)}</code>\n` +
            `💳 Charge ID: <code>${escapeHtml(chargeId)}</code>\n\n` +
            `❌ Gift Error: <code>${escapeHtml(err.message)}</code>\n` +
            `💸 Refund Error: <code>${escapeHtml(refundErrorMsg)}</code>`,
          { parse_mode: "HTML" },
        );
      } catch (_) {}

      // User Notification
      await bot.sendMessage(
        chatId,
        `⚠️ <b>Gift gagal dikirim.</b>\n\n` +
          `Pembayaran sudah diterima, tetapi refund otomatis mengalami kendala.\n` +
          `Admin sudah diberitahu.\n\n` +
          `🧾 Simpan bukti pembayaran ini.`,
        { parse_mode: "HTML" },
      );
    }
  }
});

// ==============================
// AUTO-DELETE PESAN USER & COMMANDS
// ==============================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = String(msg.from.id);

  // JIKA PESAN ADALAH COMMAND (Diawali '/')
  if (msg.text.startsWith("/")) {
    // Hapus command sebelumnya jika ada
    const previousCommandId = lastUserCommandMsg.get(userId);
    if (previousCommandId) {
      try {
        await bot.deleteMessage(msg.chat.id, previousCommandId);
      } catch (_) {
        // Abaikan jika pesan sudah terhapus
      }
    }

    // Simpan message_id command yang baru
    lastUserCommandMsg.set(userId, msg.message_id);
    return;
  }

  // JIKA PESAN BIASA (BUKAN COMMAND)
  deleteUserMessage(msg);
});

// ==============================
// MESSAGE LOGGER
// ==============================

bot.on("message", (msg) => {
  const date = new Date().toLocaleString("id-ID");

  const userId = msg.from?.id || "-";
  const username = msg.from?.username ? `@${msg.from.username}` : "-";

  const firstName = msg.from?.first_name || "-";
  const lastName = msg.from?.last_name || "";

  const chatId = msg.chat?.id || "-";
  const chatType = msg.chat?.type || "-";
  const messageId = msg.message_id || "-";

  let messageType = "UNKNOWN";
  let content = "";

  if (msg.text) {
    messageType = "TEXT";
    content = msg.text;
  } else if (msg.photo) {
    messageType = "PHOTO";
    content = "[Foto]";
  } else if (msg.video) {
    messageType = "VIDEO";
    content = "[Video]";
  } else if (msg.document) {
    messageType = "DOCUMENT";
    content = `[Dokumen] ${msg.document.file_name || ""}`;
  } else if (msg.sticker) {
    messageType = "STICKER";
    content = `[Sticker] ${msg.sticker.emoji || ""}`;
  } else if (msg.voice) {
    messageType = "VOICE";
    content = "[Voice Message]";
  } else if (msg.audio) {
    messageType = "AUDIO";
    content = `[Audio] ${msg.audio.title || ""}`;
  } else if (msg.video_note) {
    messageType = "VIDEO_NOTE";
    content = "[Video Note]";
  } else if (msg.location) {
    messageType = "LOCATION";
    content = "[Location]";
  } else if (msg.contact) {
    messageType = "CONTACT";
    content = "[Contact]";
  } else {
    content = "[Pesan non-text]";
  }

  console.log(`
╭──────────────────────────────────
│ 📩 MESSAGE MASUK
├──────────────────────────────────
│ 🕐 Waktu     : ${date}
│ 👤 User ID   : ${userId}
│ 🔹 Username  : ${username}
│ 📝 Nama      : ${firstName} ${lastName}
│ 💬 Chat ID   : ${chatId}
│ 📱 Chat Type : ${chatType}
│ 🆔 Message ID: ${messageId}
│ 📦 Tipe      : ${messageType}
│ 💭 Pesan     : ${content}
╰──────────────────────────────────
`);
});

// ==============================
// CRASH RECOVERY & STARTUP CHECK
// ==============================

function performCrashRecoveryCheck() {
  const needsRecovery = [...orders.values()].filter((o) =>
    ["PAID", "PROCESSING", "FAILED", "REFUNDING", "REFUND_FAILED"].includes(
      o.status,
    ),
  );

  if (needsRecovery.length > 0) {
    console.log(
      `Crash recovery detected ${needsRecovery.length} unhandled order(s).`,
    );
    try {
      let recoveryMsg = `🚨 <b>RECOVERY SISTEM (BOT RESTART)</b>\n\nDitemukan <b>${needsRecovery.length}</b> order perlu penanganan:\n\n`;
      needsRecovery.forEach((o, index) => {
        recoveryMsg +=
          `${index + 1}. 🎁 ${escapeHtml(o.giftName)}\n` +
          `👤 Buyer: <code>${o.buyerId}</code>\n` +
          `📌 Status: <b>${o.status}</b>\n` +
          `💳 Charge ID: <code>${escapeHtml(o.telegramPaymentChargeId || "-")}</code>\n\n`;
      });
      recoveryMsg += `Gunakan command /recovery untuk detail.`;

      bot
        .sendMessage(OWNER_ID, recoveryMsg, { parse_mode: "HTML" })
        .catch(() => {});
    } catch (e) {
      logError(`Gagal notif recovery ke owner: ${e.message}`);
    }
  }
}

// ==============================
// GLOBAL ERROR HANDLERS & SHUTDOWN
// ==============================

bot.on("polling_error", (err) => {
  console.error(`[POLLING ERROR] ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[UNHANDLED REJECTION] ${reason}`);
});

async function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Menerima sinyal shutdown.`);
  console.log(`Bot shutting down cleanly via ${signal}`);

  try {
    await bot.stopPolling();
  } catch (_) {}

  try {
    await closeDB();
  } catch (_) {}

  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ==============================
// BOT READY
// ==============================

async function initializeBot() {
  try {
    await connectDB();

    // Load users
    const db = getDB();
    const dbUsers = await db.users.find({}).toArray();

    for (const user of dbUsers) {
      users.set(String(user.id), user);
    }

    // Load orders
    const dbOrders = await getOrders(10000);

    for (const order of dbOrders) {
      orders.set(String(order.buyerId), order);
    }

    // Load history
    const dbHistory = await getHistory(10000);

    history.push(...dbHistory);

    // Load settings
    settings = await getSettings();

    // Restore processed payloads
    for (const item of history) {
      if (
        item.status === "SENT" ||
        item.status === "REFUNDED" ||
        item.refundStatus === "REFUNDED"
      ) {
        if (item.payload) {
          processedPayloads.add(String(item.payload));
        }
      }
    }

    performCrashRecoveryCheck();

    console.log(`👤 Users: ${users.size}`);

    console.log(`📦 Active Orders: ${orders.size}`);

    console.log(`📜 History: ${history.length}`);

    console.log(`⚙️ Maintenance: ${settings.maintenance}`);

    bot.startPolling();

    console.log("🤖 Nifz Gift Bot berjalan.");
  } catch (error) {
    console.error("❌ Gagal menjalankan bot:", error);
    process.exit(1);
  }
}

initializeBot();
