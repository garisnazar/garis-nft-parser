
const GROUP_ID = "-1004393603844";

const TOPICS = {
  new: 5,
  expensive: 4,
  cheap: 3
};

const WALLET =
  "UQChRfzub4CLp2FAV998bfowFC4eE3aqIRQQeZinoajQ0oOG";

const PLANS = {
  day: { name: "1 день", seconds: 86400, amount: 1 },
  week: { name: "7 дней", seconds: 604800, amount: 3 },
  forever: { name: "Навсегда", seconds: null, amount: 15 }
};

const TRIAL_SECONDS = 1800;
const ORDER_LIFETIME = 1800;
const RESERVE_COOLDOWN = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        project: "Garis NFT Parser",
        payment: "TON",
        parser: env.NFTPARS_API_KEY ? "configured" : "not_configured",
        status: "working"
      });
    }

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (
        !env.WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
          env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;

      try {
        update = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      try {
        if (update.message) {
          await handleMessage(update.message, env);
        }

        if (update.callback_query) {
          await handleCallback(update.callback_query, env);
        }
      } catch (error) {
        console.error("BOT ERROR:", error);
      }

      return new Response("OK");
    }

    return new Response("Garis NFT Parser is running");
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      Promise.allSettled([
        checkTonPayments(env),
        expireSubscriptions(env),
        runNftParser(env)
      ])
    );
  }
};

// ==========================================
// TELEGRAM API
// ==========================================

async function telegram(method, env, body = {}) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram ${method}: ${result.description || response.status}`
    );
  }

  return result.result;
}

async function sendMessage(chatId, text, env, keyboard = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (keyboard) body.reply_markup = keyboard;

  return telegram("sendMessage", env, body);
}

async function answerCallback(queryId, env, text = "", alert = false) {
  return telegram("answerCallbackQuery", env, {
    callback_query_id: queryId,
    text,
    show_alert: alert
  });
}

// ==========================================
// GENERAL HELPERS
// ==========================================

function now() {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function getGroupId(env) {
  return env.PRIVATE_GROUP_ID || GROUP_ID;
}

// ==========================================
// DATABASE
// ==========================================

async function ensureParserTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_cooldowns (
      telegram_id INTEGER PRIMARY KEY,
      last_reserved_at INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS parser_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();
}

async function saveUser(user, env) {
  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id, username, first_name, created_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).bind(
    user.id,
    user.username || null,
    user.first_name || "",
    now()
  ).run();
}

async function getActiveSubscription(userId, env) {
  return env.DB.prepare(`
    SELECT *
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND starts_at <= ?
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END DESC,
      expires_at DESC
    LIMIT 1
  `).bind(userId, now(), now()).first();
}

// ==========================================
// MESSAGES
// ==========================================

async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text || "";
  const command = text.split(" ")[0].split("@")[0];

  if (
    command === "/ids" &&
    ["group", "supergroup"].includes(message.chat.type)
  ) {
    await telegram("sendMessage", env, {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
      text:
        "💎 GARIS NFT PARSER\n\n" +
        "ID группы: " + chatId + "\n" +
        "ID темы: " + (message.message_thread_id || "Главная тема")
    });
    return;
  }

  if (!user || chatId !== user.id) return;

  await saveUser(user, env);

  if (command === "/start" || command.startsWith("/start ")) {
    await showMenu(chatId, env);
    return;
  }

  if (command === "/myaccess") {
    await showAccess(chatId, env);
    return;
  }

  if (command === "/nftstatus") {
    await showNftStatus(chatId, env);
    return;
  }

  if (command === "/nfttest") {
    await showNftTest(chatId, env);
    return;
  }

  if (command === "/paysupport") {
    const support = env.SUPPORT_USERNAME
      ? "@" + env.SUPPORT_USERNAME
      : "Поддержка пока не настроена";

    await sendMessage(
      chatId,
      "💬 <b>Поддержка Garis NFT Parser</b>\n\n" +
      "По вопросам оплаты и доступа:\n" + escapeHtml(support),
      env
    );
    return;
  }

  if (command === "/help") {
    await sendMessage(
      chatId,
      "📚 <b>Команды</b>\n\n" +
      "/start — главное меню\n" +
      "/myaccess — моя подписка\n" +
      "/nftstatus — состояние NFT-парсера\n" +
      "/nfttest — тест поиска NFTPARS\n" +
      "/paysupport — поддержка\n" +
      "/help — помощь",
      env
    );
  }
}

// ==========================================
// NFTPARS STATUS
// ==========================================

async function showNftStatus(chatId, env) {
  if (!env.NFTPARS_API_KEY) {
    await sendMessage(
      chatId,
      "❌ NFTPARS_API_KEY не найден в настройках Worker.",
      env
    );
    return;
  }

  try {
    const response = await fetch(
      "https://nftpars.app/api/v1/stats/indexing",
      {
        headers: {
          Authorization: "Bearer " + env.NFTPARS_API_KEY,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(
        data.error?.code || "HTTP " + response.status
      );
    }

    await sendMessage(
      chatId,
      "💎 <b>NFTPARS подключён</b>\n\n" +
      "Статус API: <b>доступен</b>\n" +
      "Запрос статистики выполнен успешно.\n\n" +
      "Полная статистика индексации доступна в кабинете NFTPARS.",
      env
    );
  } catch (error) {
    console.error("NFTPARS STATUS ERROR:", error);

    await sendMessage(
      chatId,
      "❌ Не удалось проверить NFTPARS.\n\n" +
      "Ошибка: <code>" + escapeHtml(error.message) + "</code>",
      env
    );
  }
}

// ==========================================
// NFTPARS SEARCH TEST
// ==========================================

async function showNftTest(chatId, env) {
  await sendMessage(
    chatId,
    "🔎 <b>Проверяю поиск NFTPARS...</b>\n\n" +
    "Выполняю тестовый запрос. Публикации не будет.",
    env
  );

  try {
    const params = new URLSearchParams();

    params.set("owner_status", "VERIFIED");
    params.set("limit", "5");

    const result = await nftparsRequest(
      "/search?" + params.toString(),
      env
    );

    const data = result.data || {};

    let items = [];

    if (Array.isArray(data)) {
      items = data;
    } else if (Array.isArray(data.items)) {
      items = data.items;
    } else if (Array.isArray(data.results)) {
      items = data.results;
    } else if (Array.isArray(data.gifts)) {
      items = data.gifts;
    }

    const first = items[0] || {};
    const gift = first.gift || first;
    const owner = gift.owner || {};

    const dataKeys = Object.keys(data);
    const itemKeys = Object.keys(first);
    const giftKeys = Object.keys(gift);

    const ownerStatus = owner.status || "не найден";

    const title =
      gift.title ||
      gift.name ||
      gift.slug ||
      "Название не найдено";

    const collection =
      gift.collection?.name ||
      gift.collection?.slug ||
      "Не указана";

    const cursor =
      data.next_cursor ||
      data.nextCursor ||
      null;

    let report =
      "💎 <b>РЕЗУЛЬТАТ ТЕСТА NFTPARS</b>\n\n" +
      "🟢 API: запрос успешен\n" +
      "📦 Получено записей: <b>" + items.length + "</b>\n" +
      "👤 Статус первого владельца: <b>" +
      escapeHtml(ownerStatus) + "</b>\n\n" +
      "📋 <b>Структура ответа</b>\n" +
      "Поля data: <code>" +
      escapeHtml(dataKeys.join(", ") || "нет") +
      "</code>\n\n" +
      "Поля первой записи: <code>" +
      escapeHtml(itemKeys.join(", ") || "нет") +
      "</code>\n\n" +
      "Поля подарка: <code>" +
      escapeHtml(giftKeys.join(", ") || "нет") +
      "</code>\n\n";

    if (items.length > 0) {
      report +=
        "🎁 <b>Первая находка</b>\n" +
        "Название: " + escapeHtml(title) + "\n" +
        "Коллекция: " + escapeHtml(collection) + "\n" +
        "Владелец: " + escapeHtml(ownerStatus) + "\n\n";
    } else {
      report +=
        "⚠️ По этому запросу записей не найдено.\n\n";
    }

    report +=
      "🔄 Следующая страница: " +
      (cursor ? "есть" : "нет") + "\n\n" +
      "Тест завершён. Публикации не выполнялись.";

    await sendMessage(chatId, report, env);

    console.log("NFTPARS TEST:", {
      dataKeys,
      itemCount: items.length,
      itemKeys,
      giftKeys,
      ownerStatus,
      hasCursor: Boolean(cursor)
    });

  } catch (error) {
    console.error("NFTPARS SEARCH TEST ERROR:", error);

    await sendMessage(
      chatId,
      "❌ <b>Ошибка теста поиска</b>\n\n" +
      "<code>" + escapeHtml(error.message) + "</code>",
      env
    );
  }
}

// ==========================================
// MENU
// ==========================================

async function showMenu(chatId, env) {
  await sendMessage(
    chatId,
    "💎 <b>Garis NFT Parser</b>\n\n" +
    "Доступ к приватной группе с NFT-находками.\n\n" +
    "Выбери тариф:",
    env,
    {
      inline_keyboard: [
        [{ text: "🎁 Пробный доступ — 30 минут", callback_data: "trial" }],
        [{ text: "📅 1 день — 1 TON", callback_data: "plan:day" }],
        [{ text: "🔥 7 дней — 3 TON", callback_data: "plan:week" }],
        [{ text: "♾ Навсегда — 15 TON", callback_data: "plan:forever" }],
        [{ text: "📊 Мой доступ", callback_data: "access" }]
      ]
    }
  );
}

// ==========================================
// CALLBACKS
// ==========================================

async function handleCallback(query, env) {
  const data = query.data || "";
  const userId = query.from.id;

  if (data.startsWith("reserve:")) {
    await reserveGift(query, env);
    return;
  }

  await answerCallback(query.id, env);

  const chatId = query.message?.chat?.id;

  if (!chatId || chatId !== userId) return;

  await saveUser(query.from, env);

  if (data === "trial") {
    await activateTrial(userId, chatId, env);
    return;
  }

  if (data === "access") {
    await showAccess(chatId, env);
    return;
  }

  if (data.startsWith("plan:")) {
    await createTonOrder(
      userId,
      chatId,
      data.split(":")[1],
      env
    );
  }
}

// ==========================================
// TRIAL
// ==========================================

async function activateTrial(userId, chatId, env) {
  const active = await getActiveSubscription(userId, env);

  if (active) {
    await sendMessage(chatId, "У тебя уже есть активная подписка.", env);
    return;
  }

  const result = await env.DB.prepare(`
    UPDATE users
    SET trial_used = 1
    WHERE telegram_id = ?
      AND trial_used = 0
  `).bind(userId).run();

  if (result.meta.changes !== 1) {
    await sendMessage(
      chatId,
      "❌ Пробный доступ уже использован.\n\nВыбери платный тариф.",
      env
    );
    return;
  }

  const expiresAt = now() + TRIAL_SECONDS;

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      telegram_id, plan, starts_at, expires_at, status
    )
    VALUES (?, 'trial', ?, ?, 'active')
  `).bind(userId, now(), expiresAt).run();

  await sendJoinLink(userId, chatId, expiresAt, env);
}

// ==========================================
// TON ORDER
// ==========================================

async function createTonOrder(userId, chatId, planName, env) {
  const plan = PLANS[planName];

  if (!plan) return;

  if (!env.TON_API_KEY || !env.TON_WALLET) {
    await sendMessage(chatId, "⚙️ Оплата TON пока не настроена.", env);
    return;
  }

  const active = await getActiveSubscription(userId, env);

  if (active && active.expires_at === null) {
    await sendMessage(
      chatId,
      "♾ У тебя уже есть бессрочный доступ.",
      env
    );
    return;
  }

  const orderId = crypto.randomUUID();
  const comment = "GARIS-" + crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)
    .toUpperCase();

  const amountNano = plan.amount * 1000000000;

  await env.DB.prepare(`
    INSERT INTO ton_orders (
      id, telegram_id, plan, amount_nano,
      payment_comment, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    orderId,
    userId,
    planName,
    amountNano,
    comment,
    now()
  ).run();

  const paymentUrl =
    "ton://transfer/" +
    encodeURIComponent(env.TON_WALLET) +
    "?amount=" + amountNano +
    "&text=" + encodeURIComponent(comment);

  await sendMessage(
    chatId,
    "💎 <b>Оплата Garis NFT Parser</b>\n\n" +
    "Тариф: <b>" + plan.name + "</b>\n" +
    "Сумма: <b>" + plan.amount + " TON</b>\n\n" +
    "Кошелёк:\n<code>" + escapeHtml(env.TON_WALLET) + "</code>\n\n" +
    "Комментарий к переводу:\n<code>" + comment + "</code>\n\n" +
    "⏳ Заказ действует 30 минут. После перевода бот проверит оплату автоматически.",
    env,
    {
      inline_keyboard: [
        [{ text: "💎 Оплатить " + plan.amount + " TON", url: paymentUrl }],
        [{ text: "🔄 Проверить доступ", callback_data: "access" }]
      ]
    }
  );
}

// ==========================================
// TON CENTER API V3
// ==========================================

async function getTonTransactions(env) {
  const url = new URL("https://toncenter.com/api/v3/transactions");

  url.searchParams.set("account", env.TON_WALLET);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "desc");

  const response = await fetch(url.toString(), {
    headers: {
      "X-API-Key": env.TON_API_KEY,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("TON Center HTTP " + response.status);
  }

  const data = await response.json();

  if (!Array.isArray(data.transactions)) {
    throw new Error("Unexpected TON Center response");
  }

  return data.transactions;
}

function getTransactionComment(tx) {
  const msg = tx.in_msg || {};
  const content = msg.message_content || {};
  const decoded = content.decoded || {};

  const candidates = [
    decoded.text_comment,
    decoded.comment,
    decoded.text,
    msg.message,
    msg.text
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

async function checkTonPayments(env) {
  if (!env.TON_API_KEY || !env.TON_WALLET) return;

  try {
    const transactions = await getTonTransactions(env);
    const currentTime = now();

    for (const tx of transactions) {
      const msg = tx.in_msg;

      if (!msg || !msg.value) continue;

      const comment = getTransactionComment(tx);
      if (!comment) continue;

      const txHash = tx.hash || msg.hash;
      if (!txHash) continue;

      const value = BigInt(msg.value);
      const txTime = Number(tx.now || msg.created_at || 0);

      const order = await env.DB.prepare(`
        SELECT *
        FROM ton_orders
        WHERE payment_comment = ?
          AND status = 'pending'
          AND created_at <= ?
      `).bind(comment, txTime || currentTime).first();

      if (!order) continue;

      if (currentTime - order.created_at > ORDER_LIFETIME) {
        await env.DB.prepare(`
          UPDATE ton_orders
          SET status = 'expired'
          WHERE id = ? AND status = 'pending'
        `).bind(order.id).run();
        continue;
      }

      if (value !== BigInt(order.amount_nano)) {
        console.error("Wrong TON amount for order:", order.id);
        continue;
      }

      await activatePaidOrder(order, txHash, env);
    }
  } catch (error) {
    console.error("TON PAYMENT CHECK ERROR:", error);
  }
}

// ==========================================
// ACTIVATE PAID ORDER
// ==========================================

async function activatePaidOrder(order, txHash, env) {
  const update = await env.DB.prepare(`
    UPDATE ton_orders
    SET status = 'paid',
        tx_hash = ?,
        paid_at = ?
    WHERE id = ?
      AND status = 'pending'
      AND tx_hash IS NULL
  `).bind(txHash, now(), order.id).run();

  if (update.meta.changes !== 1) return;

  const plan = PLANS[order.plan];
  if (!plan) return;

  const currentTime = now();

  const current = await env.DB.prepare(`
    SELECT
      MAX(expires_at) AS expiry,
      SUM(
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END
      ) AS permanent
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
  `).bind(order.telegram_id, currentTime).first();

  let expiresAt = null;

  if (Number(current?.permanent || 0) > 0) {
    expiresAt = null;
  } else {
    const startTime = Math.max(
      currentTime,
      Number(current?.expiry || currentTime)
    );

    expiresAt = plan.seconds
      ? startTime + plan.seconds
      : null;

    await env.DB.prepare(`
      INSERT INTO subscriptions (
        telegram_id, plan, starts_at, expires_at, status
      )
      VALUES (?, ?, ?, ?, 'active')
    `).bind(
      order.telegram_id,
      order.plan,
      startTime,
      expiresAt
    ).run();
  }

  const expiryText = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString("ru-RU")
    : "♾ Навсегда";

  await sendMessage(
    order.telegram_id,
    "✅ <b>Оплата получена!</b>\n\n" +
    "Тариф: " + plan.name + "\n" +
    "Сумма: " + plan.amount + " TON\n" +
    "Окончание доступа: " + expiryText,
    env
  );

  await sendJoinLink(
    order.telegram_id,
    order.telegram_id,
    expiresAt,
    env
  );
}

// ==========================================
// INVITE LINK
// ==========================================

async function sendJoinLink(userId, chatId, expiresAt, env) {
  const inviteBody = {
    chat_id: getGroupId(env),
    member_limit: 1,
    name: "Garis-" + userId + "-" + Date.now()
  };

  if (expiresAt) inviteBody.expire_date = expiresAt;

  const invite = await telegram(
    "createChatInviteLink",
    env,
    inviteBody
  );

  await sendMessage(
    chatId,
    "🎉 <b>Доступ активирован!</b>\n\n" +
    "Нажми кнопку ниже, чтобы войти в приватную группу.",
    env,
    {
      inline_keyboard: [
        [{ text: "🚀 Войти в группу", url: invite.invite_link }]
      ]
    }
  );
}

// ==========================================
// ACCESS INFO
// ==========================================

async function showAccess(chatId, env) {
  const subscription = await getActiveSubscription(chatId, env);

  if (!subscription) {
    await sendMessage(
      chatId,
      "❌ Активной подписки нет.\n\nНажми /start, чтобы выбрать тариф.",
      env
    );
    return;
  }

  const expiry = subscription.expires_at
    ? new Date(subscription.expires_at * 1000).toLocaleString("ru-RU")
    : "♾ Навсегда";

  await sendMessage(
    chatId,
    "📊 <b>Твой доступ</b>\n\n" +
    "Тариф: " + escapeHtml(subscription.plan) + "\n" +
    "Окончание: " + expiry,
    env
  );
}

// ==========================================
// EXPIRE SUBSCRIPTIONS
// ==========================================

async function expireSubscriptions(env) {
  const currentTime = now();

  try {
    const expired = await env.DB.prepare(`
      SELECT DISTINCT telegram_id
      FROM subscriptions
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).bind(currentTime).all();

    for (const row of expired.results || []) {
      const futureOrCurrent = await env.DB.prepare(`
        SELECT id
        FROM subscriptions
        WHERE telegram_id = ?
          AND status = 'active'
          AND (
            expires_at IS NULL
            OR expires_at > ?
            OR starts_at > ?
          )
        LIMIT 1
      `).bind(
        row.telegram_id,
        currentTime,
        currentTime
      ).first();

      await env.DB.prepare(`
        UPDATE subscriptions
        SET status = 'expired'
        WHERE telegram_id = ?
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at <= ?
      `).bind(row.telegram_id, currentTime).run();

      if (futureOrCurrent) continue;

      try {
        await telegram("banChatMember", env, {
          chat_id: getGroupId(env),
          user_id: row.telegram_id
        });

        await telegram("unbanChatMember", env, {
          chat_id: getGroupId(env),
          user_id: row.telegram_id,
          only_if_banned: true
        });
      } catch (error) {
        console.error("Member removal error:", row.telegram_id, error);
      }
    }
  } catch (error) {
    console.error("EXPIRE SUBSCRIPTIONS ERROR:", error);
  }
}

// ==========================================
// NFTPARS API
// ==========================================

async function nftparsRequest(path, env) {
  if (!env.NFTPARS_API_KEY) {
    throw new Error("NFTPARS_API_KEY is missing");
  }

  const response = await fetch(
    "https://nftpars.app/api/v1" + path,
    {
      headers: {
        Authorization: "Bearer " + env.NFTPARS_API_KEY,
        Accept: "application/json"
      }
    }
  );

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error("NFTPARS returned invalid JSON");
  }

  if (!response.ok || body.ok === false) {
    throw new Error(
      body.error?.code ||
      body.error?.message ||
      "NFTPARS HTTP " + response.status
    );
  }

  return body;
}

// ==========================================
// NFT PARSER
// ==========================================

async function runNftParser(env) {
  if (!env.NFTPARS_API_KEY) return;

  try {
    await ensureParserTables(env);

    const lastScan = await env.DB.prepare(`
      SELECT value
      FROM parser_state
      WHERE key = 'last_scan'
    `).first();

    const lastScanTime = Number(lastScan?.value || 0);

    if (now() - lastScanTime < 300) return;

    await env.DB.prepare(`
      INSERT INTO parser_state (key, value)
      VALUES ('last_scan', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(String(now())).run();

    const cursorRow = await env.DB.prepare(`
      SELECT value
      FROM parser_state
      WHERE key = 'search_cursor'
    `).first();

    const cursor = cursorRow?.value || null;

    const params = new URLSearchParams();
    params.set("owner_status", "VERIFIED");
    params.set("limit", "50");

    if (cursor) params.set("cursor", cursor);

    const result = await nftparsRequest(
      "/search?" + params.toString(),
      env
    );

    const data = result.data || {};
    const items = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.gifts)
        ? data.gifts
        : Array.isArray(data.results)
          ? data.results
          : [];

    let published = 0;

    for (const gift of items) {
      const owner = gift.owner || {};
      const telegramOwner = owner.telegram || {};

      if (owner.status !== "VERIFIED") continue;
      if (!telegramOwner.id) continue;

      const slug = gift.slug || gift.id;
      if (!slug) continue;

      const collection =
        gift.collection?.name ||
        gift.collection?.slug ||
        "Telegram Gift";

      const giftName =
        gift.title ||
        gift.name ||
        slug;

      const username = telegramOwner.username || null;
      const ownerId = Number(telegramOwner.id);

      const insert = await env.DB.prepare(`
        INSERT OR IGNORE INTO nft_items (
          id,
          collection,
          gift_name,
          owner_username,
          owner_id,
          premium,
          gifts_count,
          category,
          source,
          discovered_at,
          status
        )
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 'new', 'NFTPARS', ?, 'available')
      `).bind(
        String(slug),
        String(collection),
        String(giftName),
        username,
        ownerId,
        now()
      ).run();

      if (insert.meta.changes !== 1) continue;

      await publishNft(gift, owner, env);
      published++;
    }

    const nextCursor = data.next_cursor || null;

    await env.DB.prepare(`
      INSERT INTO parser_state (key, value)
      VALUES ('search_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(nextCursor || "").run();

    console.log(
      "NFTPARS scan completed:",
      "received =", items.length,
      "published =", published,
      "next cursor =", Boolean(nextCursor)
    );

  } catch (error) {
    console.error("NFTPARS PARSER ERROR:", error);
  }
}

// ==========================================
// PUBLISH NFT
// ==========================================

async function publishNft(gift, owner, env) {
  const telegramOwner = owner.telegram || {};

  const slug = gift.slug || gift.id;
  const collection =
    gift.collection?.name ||
    gift.collection?.slug ||
    "Telegram Gift";

  const title =
    gift.title ||
    gift.name ||
    slug;

  const username = telegramOwner.username
    ? "@" + telegramOwner.username
    : "Не указан";

  const profile = telegramOwner.username
    ? "https://t.me/" + encodeURIComponent(telegramOwner.username)
    : null;

  const giftUrl = gift.telegram_url ||
    (slug ? "https://t.me/nft/" + encodeURIComponent(slug) : null);

  let text =
    "💎 <b>НОВАЯ NFT-НАХОДКА</b>\n\n" +
    "🎁 Подарок: <b>" + escapeHtml(title) + "</b>\n" +
    "📦 Коллекция: " + escapeHtml(collection) + "\n" +
    "👤 Владелец: " + escapeHtml(username) + "\n" +
    "🟢 Статус владельца: подтверждён\n" +
    "🔎 Источник: NFTPARS";

  if (profile) {
    text += "\n\n👤 <a href=\"" + escapeHtml(profile) + "\">Открыть профиль</a>";
  }

  if (giftUrl) {
    text += "\n🎁 <a href=\"" + escapeHtml(giftUrl) + "\">Открыть подарок</a>";
  }

  const keyboard = {
    inline_keyboard: [
      [{
        text: "🔒 Занять",
        callback_data: "reserve:" + String(slug)
      }]
    ]
  };

  await telegram("sendMessage", env, {
    chat_id: getGroupId(env),
    message_thread_id: TOPICS.new,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

// ==========================================
// RESERVE NFT — 30 SECOND COOLDOWN
// ==========================================

async function reserveGift(query, env) {
  const giftId = query.data.slice("reserve:".length);
  const userId = query.from.id;
  const message = query.message;

  if (!giftId || !message) {
    await answerCallback(query.id, env, "Некорректный подарок", true);
    return;
  }

  const subscription = await getActiveSubscription(userId, env);

  if (!subscription) {
    await answerCallback(
      query.id,
      env,
      "Для бронирования нужна активная подписка. Напиши боту /start.",
      true
    );
    return;
  }

  await ensureParserTables(env);

  const gift = await env.DB.prepare(`
    SELECT *
    FROM nft_items
    WHERE id = ?
      AND status = 'available'
  `).bind(giftId).first();

  if (!gift) {
    await answerCallback(
      query.id,
      env,
      "Этот подарок уже занят или недоступен.",
      true
    );
    return;
  }

  const currentTime = now();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO user_cooldowns (
      telegram_id, last_reserved_at
    )
    VALUES (?, 0)
  `).bind(userId).run();

  const cooldown = await env.DB.prepare(`
    SELECT last_reserved_at
    FROM user_cooldowns
    WHERE telegram_id = ?
  `).bind(userId).first();

  const previousTime = Number(cooldown?.last_reserved_at || 0);
  const remaining = RESERVE_COOLDOWN - (currentTime - previousTime);

  if (remaining > 0) {
    await answerCallback(
      query.id,
      env,
      "⏳ Следующий подарок можно занять через " + remaining + " сек.",
      true
    );
    return;
  }

  const cooldownUpdate = await env.DB.prepare(`
    UPDATE user_cooldowns
    SET last_reserved_at = ?
    WHERE telegram_id = ?
      AND last_reserved_at = ?
  `).bind(
    currentTime,
    userId,
    previousTime
  ).run();

  if (cooldownUpdate.meta.changes !== 1) {
    await answerCallback(
      query.id,
      env,
      "⏳ Подожди немного и попробуй снова.",
      true
    );
    return;
  }

  const giftUpdate = await env.DB.prepare(`
    UPDATE nft_items
    SET status = 'reserved'
    WHERE id = ?
      AND status = 'available'
  `).bind(giftId).run();

  if (giftUpdate.meta.changes !== 1) {
    await env.DB.prepare(`
      UPDATE user_cooldowns
      SET last_reserved_at = ?
      WHERE telegram_id = ?
        AND last_reserved_at = ?
    `).bind(
      previousTime,
      userId,
      currentTime
    ).run();

    await answerCallback(
      query.id,
      env,
      "Этот подарок уже заняли.",
      true
    );
    return;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO reservations (
        nft_id, telegram_id, reserved_at
      )
      VALUES (?, ?, ?)
    `).bind(giftId, userId, currentTime).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE nft_items
      SET status = 'available'
      WHERE id = ?
        AND status = 'reserved'
    `).bind(giftId).run();

    await env.DB.prepare(`
      UPDATE user_cooldowns
      SET last_reserved_at = ?
      WHERE telegram_id = ?
        AND last_reserved_at = ?
    `).bind(
      previousTime,
      userId,
      currentTime
    ).run();

    throw error;
  }

  await answerCallback(
    query.id,
    env,
    "✅ Подарок закреплён за тобой!"
  );

  const originalText = message.text || message.caption || "NFT-подарок";

  try {
    await telegram("editMessageText", env, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: originalText + "\n\n🔒 <b>ПОДАРОК ЗАНЯТ</b>",
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error("Message edit error:", error);
  }

  const owner = gift.owner_username
    ? "@" + gift.owner_username
    : "Публичный username не указан.";

  try {
    await sendMessage(
      userId,
      "✅ <b>Подарок закреплён за тобой!</b>\n\n" +
      "Подарок: " + escapeHtml(gift.gift_name) + "\n" +
      "Владелец: " + escapeHtml(owner) + "\n\n" +
      "⏳ Следующий подарок можно занять через 30 секунд.",
      env
    );
  } catch (error) {
    console.error("Private message error:", error);
  }
}
