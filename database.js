const { MongoClient } = require("mongodb");
const config = require("./config");

// ========================================
// CONFIG
// ========================================

const MONGODB_URI = config.MONGODB_URI || process.env.MONGODB_URI;

const MONGODB_DB_NAME =
  config.MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || "nifz_gift";

// ========================================
// VALIDATION
// ========================================

if (!MONGODB_URI) {
  throw new Error(
    "MONGODB_URI belum diatur di config.js atau environment variable.",
  );
}

// ========================================
// MONGODB
// ========================================

let client = null;
let db = null;

const collections = {
  users: null,
  orders: null,
  history: null,
  settings: null,
};

// ========================================
// CONNECT DATABASE
// ========================================

async function connectDB() {
  if (db) {
    return collections;
  }

  console.log("🔄 Menghubungkan ke MongoDB...");

  client = new MongoClient(MONGODB_URI);

  await client.connect();

  db = client.db(MONGODB_DB_NAME);

  collections.users = db.collection("users");
  collections.orders = db.collection("orders");
  collections.history = db.collection("history");
  collections.settings = db.collection("settings");

  // ======================================
  // INDEXES
  // ======================================

  // USERS
  await collections.users.createIndex({ id: 1 }, { unique: true });

  // Username hanya di-index jika berupa string.
  // Ini aman untuk user yang username-nya null.
  await collections.users.createIndex(
    { username: 1 },
    {
      name: "username_lookup",
      partialFilterExpression: {
        username: {
          $type: "string",
        },
      },
    },
  );

  // ORDERS
  await collections.orders.createIndex(
    { buyerId: 1 },
    {
      name: "buyerId_lookup",
    },
  );

  await collections.orders.createIndex(
    { payload: 1 },
    {
      name: "payload_unique",
      unique: true,
      partialFilterExpression: {
        payload: {
          $type: "string",
        },
      },
    },
  );

  await collections.orders.createIndex(
    { status: 1 },
    {
      name: "status_lookup",
    },
  );

  await collections.orders.createIndex(
    { createdAt: -1 },
    {
      name: "createdAt_desc",
    },
  );

  // HISTORY
  await collections.history.createIndex(
    { payload: 1 },
    {
      name: "history_payload_unique",
      unique: true,
      partialFilterExpression: {
        payload: {
          $type: "string",
        },
      },
    },
  );

  await collections.history.createIndex(
    {
      buyerId: 1,
      timestamp: -1,
    },
    {
      name: "buyer_history",
    },
  );

  await collections.history.createIndex(
    { timestamp: -1 },
    {
      name: "timestamp_desc",
    },
  );

  // ======================================
  // DEFAULT SETTINGS
  // ======================================

  await collections.settings.updateOne(
    { _id: "global" },
    {
      $setOnInsert: {
        maintenance: false,
      },
    },
    {
      upsert: true,
    },
  );

  console.log("✅ MongoDB berhasil terhubung.");
  console.log(`📦 Database: ${MONGODB_DB_NAME}`);

  return collections;
}

// ========================================
// GET COLLECTIONS
// ========================================

function getDB() {
  if (!db) {
    throw new Error(
      "Database belum terhubung. Jalankan connectDB() terlebih dahulu.",
    );
  }

  return collections;
}

// ========================================
// CLOSE DATABASE
// ========================================

async function closeDB() {
  if (!client) {
    return;
  }

  console.log("🔌 Menutup koneksi MongoDB...");

  await client.close();

  client = null;
  db = null;

  collections.users = null;
  collections.orders = null;
  collections.history = null;
  collections.settings = null;

  console.log("✅ Koneksi MongoDB ditutup.");
}

// ========================================
// USER HELPERS
// ========================================

async function findUserById(id) {
  const db = getDB();

  return db.users.findOne({
    id: Number(id),
  });
}

async function findUserByUsername(username) {
  const db = getDB();

  return db.users.findOne({
    username: username.replace(/^@/, "").toLowerCase(),
  });
}

async function upsertUser(user) {
  const db = getDB();

  const userId = Number(user.id);

  if (!userId) {
    throw new Error("User ID tidak valid.");
  }

  const update = {
    id: userId,
    updatedAt: user.updatedAt || Date.now(),
  };

  if (user.username !== undefined) {
    update.username = user.username
      ? String(user.username).replace(/^@/, "").toLowerCase()
      : null;
  }

  if (user.first_name !== undefined) {
    update.first_name = user.first_name;
  }

  await db.users.updateOne(
    { id: userId },
    {
      $set: update,
    },
    {
      upsert: true,
    },
  );

  return db.users.findOne({
    id: userId,
  });
}

// ========================================
// ORDER HELPERS
// ========================================

async function findOrderByBuyerId(buyerId) {
  const db = getDB();

  return db.orders.findOne({
    buyerId: Number(buyerId),
  });
}

async function findOrderByPayload(payload) {
  const db = getDB();

  if (!payload) {
    return null;
  }

  return db.orders.findOne({
    payload: String(payload),
  });
}

async function upsertOrder(order) {
  const db = getDB();

  if (!order || !order.buyerId) {
    throw new Error("Order tidak valid.");
  }

  const buyerId = Number(order.buyerId);

  await db.orders.updateOne(
    {
      buyerId,
    },
    {
      $set: {
        ...order,
        buyerId,
      },
    },
    {
      upsert: true,
    },
  );

  return db.orders.findOne({
    buyerId,
  });
}

async function deleteOrder(buyerId) {
  const db = getDB();

  await db.orders.deleteOne({
    buyerId: Number(buyerId),
  });
}

async function getOrders(limit = 100) {
  const db = getDB();

  return db.orders
    .find({})
    .sort({
      createdAt: -1,
    })
    .limit(Number(limit))
    .toArray();
}

async function getOrdersByStatus(statuses) {
  const db = getDB();

  if (!Array.isArray(statuses)) {
    statuses = [statuses];
  }

  return db.orders
    .find({
      status: {
        $in: statuses,
      },
    })
    .sort({
      createdAt: 1,
    })
    .toArray();
}

// ========================================
// HISTORY HELPERS
// ========================================

async function addHistory(history) {
  const db = getDB();

  if (!history) {
    throw new Error("History tidak valid.");
  }

  // Hindari duplicate history berdasarkan payload.
  if (history.payload) {
    const existing = await db.history.findOne({
      payload: String(history.payload),
    });

    if (existing) {
      return existing;
    }
  }

  const document = {
    ...history,
    timestamp: history.timestamp || Date.now(),
  };

  const result = await db.history.insertOne(document);

  return {
    ...document,
    _id: result.insertedId,
  };
}

async function findHistoryByPayload(payload) {
  const db = getDB();

  if (!payload) {
    return null;
  }

  return db.history.findOne({
    payload: String(payload),
  });
}

async function updateHistoryByChargeId(chargeId, update) {
  const db = getDB();

  return db.history.updateOne(
    {
      telegramPaymentChargeId: String(chargeId),
    },
    {
      $set: update,
    },
  );
}

async function getHistory(limit = 100) {
  const db = getDB();

  return db.history
    .find({})
    .sort({
      timestamp: -1,
    })
    .limit(Number(limit))
    .toArray();
}

async function getHistoryByBuyerId(buyerId, limit = 100) {
  const db = getDB();

  return db.history
    .find({
      buyerId: Number(buyerId),
    })
    .sort({
      timestamp: -1,
    })
    .limit(Number(limit))
    .toArray();
}

// ========================================
// SETTINGS HELPERS
// ========================================

async function getSettings() {
  const db = getDB();

  let settings = await db.settings.findOne({
    _id: "global",
  });

  if (!settings) {
    await db.settings.insertOne({
      _id: "global",
      maintenance: false,
    });

    settings = {
      _id: "global",
      maintenance: false,
    };
  }

  return settings;
}

async function updateSettings(data) {
  const db = getDB();

  await db.settings.updateOne(
    {
      _id: "global",
    },
    {
      $set: data,
    },
    {
      upsert: true,
    },
  );

  return getSettings();
}

async function setMaintenance(value) {
  return updateSettings({
    maintenance: Boolean(value),
  });
}

// ========================================
// STATS
// ========================================

async function getStats() {
  const db = getDB();

  const [users, orders, history] = await Promise.all([
    db.users.countDocuments(),
    db.orders.countDocuments(),
    db.history.countDocuments(),
  ]);

  return {
    users,
    orders,
    history,
  };
}

// ========================================
// EXPORT
// ========================================

module.exports = {
  connectDB,
  getDB,
  closeDB,

  // Users
  findUserById,
  findUserByUsername,
  upsertUser,

  // Orders
  findOrderByBuyerId,
  findOrderByPayload,
  upsertOrder,
  deleteOrder,
  getOrders,
  getOrdersByStatus,

  // History
  addHistory,
  findHistoryByPayload,
  updateHistoryByChargeId,
  getHistory,
  getHistoryByBuyerId,

  // Settings
  getSettings,
  updateSettings,
  setMaintenance,

  // Stats
  getStats,
};
