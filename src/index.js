
const GROUP_ID = "-1004393603844";

const TOPICS = {
  new: 5,
  expensive: 4,
  cheap: 3
};

const WALLET =
  "UQChRfzub4CLp2FAV998bfowFC4eE3aqIRQQeZinoajQ0oOG";

const PLANS = {
  day: {
    name: "1 день",
    seconds: 86400,
    amount: 1
  },
  week: {
    name: "7 дней",
    seconds: 604800,
    amount: 3
  },
  forever: {
    name: "Навсегда",
    seconds: null,
    amount: 15
  }
};

const TRIAL_SECONDS = 1800;
const ORDER_LIFETIME = 1800;

// ==========================================
// WORKER
// ==========================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        project: "Garis NFT Parser",
        payment: "TON",
        status: "working"
      });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Garis NFT Parser is running");
    }

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
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkTonPayments(env));
    ctx.waitUntil(expireSubscriptions(env));
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
      headers: {
        "Content-Type": "application/json"
      },
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

  if (keyboard) {
    body.reply_markup = keyboard;
  }

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
// DATABASE HELPERS
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

async function saveUser(user, env) {
  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id,
      username,
      first_name,
      created_at
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
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )
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
      "/paysupport — поддержка\n" +
      "/help — помощь",
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

  // Бронирование подарка из групповой темы
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
  const current = now();

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

  const active = await getActiveSubscription(userId, env);

  if (active) {
    await sendMessage(
      chatId,
      "У тебя уже есть активная подписка.",
      env
    );
    return;
  }

  const expiresAt = current + TRIAL_SECONDS;

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      telegram_id, plan, starts_at, expires_at, status
    )
    VALUES (?, 'trial', ?, ?, 'active')
  `).bind(userId, current, expiresAt).run();

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
  const createdAt = now();

  await env.DB.prepare(`
    INSERT INTO ton_orders (
      id,
      telegram_id,
      plan,
      amount_nano,
      payment_comment,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    orderId,
    userId,
    planName,
    amountNano,
    comment,
    createdAt
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
    "Нажми кнопку, чтобы открыть кошелёк с заполненными данными.\n\n" +
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
      "Accept": "application/json"
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

// ==========================================
// CHECK TON PAYMENTS
// ==========================================

async function checkTonPayments(env) {
  if (!env.TON_API_KEY || !env.TON_WALLET) {
    console.error("TON settings are missing");
    return;
  }

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
        WHERE id = ?
          AND status = 'pending'
      `).bind(order.id).run();
      continue;
    }

    if (value !== BigInt(order.amount_nano)) {
      console.error("Wrong TON amount for order:", order.id);
      continue;
    }

    await activatePaidOrder(order, txHash, env);
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
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )
  `).bind(order.telegram_id, currentTime).first();

  const startTime = Math.max(
    currentTime,
    Number(current?.expiry || currentTime)
  );

  const expiresAt = plan.seconds
    ? startTime + plan.seconds
    : null;

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      telegram_id,
      plan,
      starts_at,
      expires_at,
      status
    )
    VALUES (?, ?, ?, ?, 'active')
  `).bind(
    order.telegram_id,
    order.plan,
    startTime,
    expiresAt
  ).run();

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
  const groupId = env.PRIVATE_GROUP_ID || GROUP_ID;

  const inviteBody = {
    chat_id: groupId,
    member_limit: 1,
    name: "Garis-" + userId + "-" + Date.now()
  };

  if (expiresAt) {
    inviteBody.expire_date = expiresAt;
  }

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
  const groupId = env.PRIVATE_GROUP_ID || GROUP_ID;
  const currentTime = now();

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
        chat_id: groupId,
        user_id: row.telegram_id
      });

      await telegram("unbanChatMember", env, {
        chat_id: groupId,
        user_id: row.telegram_id,
        only_if_banned: true
      });
    } catch (error) {
      console.error("Member removal error:", row.telegram_id, error);
    }
  }
}

// ==========================================
// RESERVE NFT
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

  const update = await env.DB.prepare(`
    UPDATE nft_items
    SET status = 'reserved'
    WHERE id = ?
      AND status = 'available'
  `).bind(giftId).run();

  if (update.meta.changes !== 1) {
    await answerCallback(query.id, env, "Подарок уже заняли.", true);
    return;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO reservations (
        nft_id,
        telegram_id,
        reserved_at
      )
      VALUES (?, ?, ?)
    `).bind(giftId, userId, now()).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE nft_items
      SET status = 'available'
      WHERE id = ?
        AND status = 'reserved'
    `).bind(giftId).run();

    throw error;
  }

  await answerCallback(query.id, env, "Подарок закреплён за тобой!");

  const originalText = message.text || message.caption || "NFT-подарок";

  try {
    await telegram("editMessageText", env, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: originalText + "\n\n🔒 <b>ПОДАРОК ЗАНЯТ</b>",
      parse_mode: "HTML"
    });
  } catch (error) {
    console.error("Message edit error:", error);
  }

  const owner = gift.owner_username
    ? "@" + gift.owner_username
    : "Владелец не указал публичный username.";

  try {
    await sendMessage(
      userId,
      "✅ <b>Подарок закреплён за тобой!</b>\n\n" +
      "Подарок: " + escapeHtml(gift.gift_name) + "\n" +
      "Владелец: " + escapeHtml(owner),
      env
    );
  } catch (error) {
    console.error("Private message error:", error);
  }
}
