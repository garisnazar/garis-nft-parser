
const PLANS = {
  day: {
    name: "1 день",
    seconds: 86400,
    priceKey: "PRICE_DAY_STARS"
  },
  week: {
    name: "7 дней",
    seconds: 604800,
    priceKey: "PRICE_WEEK_STARS"
  },
  forever: {
    name: "Навсегда",
    seconds: null,
    priceKey: "PRICE_FOREVER_STARS"
  }
};

const TRIAL_SECONDS = 1800;

// ==========================================
// ОСНОВНОЙ СЕРВЕР
// ==========================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        project: "Garis NFT Parser",
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

      if (update.pre_checkout_query) {
        await handlePreCheckout(update.pre_checkout_query, env);
      }
    } catch (error) {
      console.error("BOT ERROR:", error);
    }

    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
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
    parse_mode: "HTML"
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  return telegram("sendMessage", env, body);
}

async function answerCallback(queryId, env, text = "") {
  return telegram("answerCallbackQuery", env, {
    callback_query_id: queryId,
    text
  });
}

// ==========================================
// ОБРАБОТКА СООБЩЕНИЙ
// ==========================================

async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text || "";

  if (!user || chatId !== user.id) {
    return;
  }

  // Сохраняем пользователя

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

  // Успешная оплата

  if (message.successful_payment) {
    await handleSuccessfulPayment(message, env);
    return;
  }

  // Команды

  if (text === "/start" || text.startsWith("/start ")) {
    await showMenu(chatId, env);
    return;
  }

  if (text === "/myaccess") {
    await showAccess(chatId, env);
    return;
  }

  if (text === "/paysupport") {
    const support = env.SUPPORT_USERNAME
      ? `@${env.SUPPORT_USERNAME}`
      : "Поддержка пока не настроена";

    await sendMessage(
      chatId,
      "💬 <b>Поддержка Garis NFT Parser</b>\n\n" +
      "Если возникла проблема с оплатой или доступом, " +
      "обратись к администратору:\n" + support,
      env
    );

    return;
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      "📚 <b>Команды бота</b>\n\n" +
      "/start — главное меню\n" +
      "/myaccess — информация о подписке\n" +
      "/paysupport — поддержка",
      env
    );
  }
}

// ==========================================
// ГЛАВНОЕ МЕНЮ
// ==========================================

async function showMenu(chatId, env) {
  return sendMessage(
    chatId,
    "💎 <b>Garis NFT Parser</b>\n\n" +
    "Добро пожаловать!\n\n" +
    "Получай информацию о найденных Telegram NFT " +
    "и следи за новыми находками.\n\n" +
    "Выбери подходящий тариф:",
    env,
    {
      inline_keyboard: [
        [
          {
            text: "🎁 Пробный доступ — 30 минут",
            callback_data: "trial"
          }
        ],
        [
          {
            text: "📅 1 день",
            callback_data: "plan:day"
          }
        ],
        [
          {
            text: "🔥 7 дней",
            callback_data: "plan:week"
          }
        ],
        [
          {
            text: "♾ Навсегда",
            callback_data: "plan:forever"
          }
        ],
        [
          {
            text: "📊 Мой доступ",
            callback_data: "access"
          }
        ]
      ]
    }
  );
}

// ==========================================
// ОБРАБОТКА КНОПОК
// ==========================================

async function handleCallback(query, env) {
  const data = query.data || "";
  const userId = query.from.id;

  const chatId = query.message?.chat?.id;

  await answerCallback(query.id, env);

  if (!chatId || chatId !== userId) {
    return;
  }

  if (data === "trial") {
    await activateTrial(userId, chatId, env);
    return;
  }

  if (data === "access") {
    await showAccess(chatId, env);
    return;
  }

  if (data.startsWith("plan:")) {
    const planName = data.split(":")[1];

    await createOrder(userId, chatId, planName, env);
    return;
  }
}

// ==========================================
// БЕСПЛАТНЫЙ ПРОБНЫЙ ДОСТУП
// ==========================================

async function activateTrial(userId, chatId, env) {
  const currentTime = now();

  const result = await env.DB.prepare(`
    UPDATE users
    SET trial_used = 1
    WHERE telegram_id = ?
      AND trial_used = 0
  `).bind(userId).run();

  if (result.meta.changes !== 1) {
    await sendMessage(
      chatId,
      "❌ <b>Пробный доступ уже использован.</b>\n\n" +
      "Ты можешь выбрать один из платных тарифов.",
      env
    );

    return;
  }

  const expiresAt = currentTime + TRIAL_SECONDS;

  await env.DB.prepare(`
    INSERT INTO subscriptions (
      telegram_id,
      plan,
      starts_at,
      expires_at,
      status
    )
    VALUES (?, 'trial', ?, ?, 'active')
  `).bind(
    userId,
    currentTime,
    expiresAt
  ).run();

  await sendJoinLink(
    userId,
    chatId,
    expiresAt,
    env
  );
}

// ==========================================
// СОЗДАНИЕ СЧЕТА
// ==========================================

async function createOrder(userId, chatId, planName, env) {
  const plan = PLANS[planName];

  if (!plan) {
    return;
  }

  const price = Number(env[plan.priceKey]);

  if (!Number.isSafeInteger(price) || price <= 0) {
    await sendMessage(
      chatId,
      "⚙️ <b>Тариф пока не настроен.</b>\n\n" +
      "Попробуй позже или обратись к администратору.",
      env
    );

    return;
  }

  const orderId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO orders (
      id,
      telegram_id,
      plan,
      amount,
      currency,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, 'XTR', 'pending', ?)
  `).bind(
    orderId,
    userId,
    planName,
    price,
    now()
  ).run();

  await telegram("sendInvoice", env, {
    chat_id: chatId,

    title: "Garis NFT Parser — " + plan.name,

    description:
      "Доступ к приватной группе Garis NFT Parser. Тариф: " +
      plan.name,

    payload: orderId,

    currency: "XTR",

    prices: [
      {
        label: plan.name,
        amount: price
      }
    ]
  });
}

// ==========================================
// ПРОВЕРКА ПЕРЕД ОПЛАТОЙ
// ==========================================

async function handlePreCheckout(query, env) {
  const order = await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE id = ?
      AND telegram_id = ?
      AND status = 'pending'
      AND currency = 'XTR'
      AND amount = ?
  `).bind(
    query.invoice_payload,
    query.from.id,
    query.total_amount
  ).first();

  await telegram("answerPreCheckoutQuery", env, {
    pre_checkout_query_id: query.id,

    ok: Boolean(order),

    ...(!order
      ? {
          error_message:
            "Счёт недействителен. Создай новый счёт."
        }
      : {})
  });
}

// ==========================================
// ПОЛУЧЕНИЕ УСПЕШНОЙ ОПЛАТЫ
// ==========================================

async function handleSuccessfulPayment(message, env) {
  const payment = message.successful_payment;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const orderId = payment.invoice_payload;

  if (
    payment.currency !== "XTR" ||
    chatId !== userId
  ) {
    console.error("Invalid payment context");
    return;
  }

  const order = await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE id = ?
      AND telegram_id = ?
      AND status = 'pending'
      AND currency = 'XTR'
      AND amount = ?
  `).bind(
    orderId,
    userId,
    payment.total_amount
  ).first();

  if (!order) {
    console.error("Order not found or already paid:", orderId);
    return;
  }

  const plan = PLANS[order.plan];

  if (!plan) {
    return;
  }

  // Защита от повторной обработки одного платежа

  const updated = await env.DB.prepare(`
    UPDATE orders
    SET status = 'paid',
        telegram_charge_id = ?
    WHERE id = ?
      AND status = 'pending'
  `).bind(
    payment.telegram_payment_charge_id,
    orderId
  ).run();

  if (updated.meta.changes !== 1) {
    return;
  }

  const currentTime = now();

  const current = await env.DB.prepare(`
    SELECT
      MAX(expires_at) AS expiry,
      SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS permanent
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
  `).bind(
    userId,
    currentTime
  ).first();

  // Если у пользователя уже вечный доступ,
  // дополнительный срок ему не требуется.

  if (!current?.permanent || Number(current.permanent) === 0) {
    const startTime = Math.max(
      currentTime,
      current?.expiry || currentTime
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
      userId,
      order.plan,
      startTime,
      expiresAt
    ).run();
  }

  await sendMessage(
    chatId,
    "✅ <b>Оплата успешно получена!</b>\n\n" +
    "Тариф: " + plan.name + "\n\n" +
    "Твой доступ активирован.",
    env
  );

  await sendJoinLink(
    userId,
    chatId,
    plan.seconds
      ? Math.max(currentTime, current?.expiry || currentTime) +
        plan.seconds
      : null,
    env
  );
}

// ==========================================
// ВЫДАЧА ССЫЛКИ В ПРИВАТНУЮ ГРУППУ
// ==========================================

async function sendJoinLink(userId, chatId, expiresAt, env) {
  if (!env.PRIVATE_GROUP_ID) {
    await sendMessage(
      chatId,
      "✅ <b>Доступ активирован!</b>\n\n" +
      "Приватная группа пока не подключена.",
      env
    );

    return;
  }

  const inviteBody = {
    chat_id: env.PRIVATE_GROUP_ID,

    member_limit: 1,

    name: `Garis-${userId}-${Date.now()}`
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
    "🎉 <b>Твой доступ активирован!</b>\n\n" +
    "Нажми кнопку ниже, чтобы войти в приватную группу Garis NFT Parser.",
    env,
    {
      inline_keyboard: [
        [
          {
            text: "🚀 Войти в группу",
            url: invite.invite_link
          }
        ]
      ]
    }
  );
}

// ==========================================
// ПРОВЕРКА ПОДПИСКИ
// ==========================================

async function showAccess(chatId, env) {
  const currentTime = now();

  const subscription = await env.DB.prepare(`
    SELECT plan, expires_at
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END DESC,
      expires_at DESC
    LIMIT 1
  `).bind(
    chatId,
    currentTime
  ).first();

  if (!subscription) {
    await sendMessage(
      chatId,
      "❌ <b>У тебя нет активной подписки.</b>\n\n" +
      "Нажми /start, чтобы выбрать тариф.",
      env
    );

    return;
  }

  const expiry = subscription.expires_at
    ? new Date(
        subscription.expires_at * 1000
      ).toLocaleString("ru-RU")
    : "♾ Навсегда";

  await sendMessage(
    chatId,
    "📊 <b>Информация о доступе</b>\n\n" +
    "Тариф: " + subscription.plan + "\n" +
    "Окончание: " + expiry,
    env
  );
}

// ==========================================
// АВТОМАТИЧЕСКОЕ УДАЛЕНИЕ ИСТЁКШИХ ПОДПИСОК
// ==========================================

async function expireSubscriptions(env) {
  if (!env.PRIVATE_GROUP_ID) {
    return;
  }

  const currentTime = now();

  const expired = await env.DB.prepare(`
    SELECT DISTINCT telegram_id
    FROM subscriptions
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).bind(currentTime).all();

  for (const row of expired.results || []) {
    const active = await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE telegram_id = ?
        AND status = 'active'
        AND (
          expires_at IS NULL
          OR expires_at > ?
        )
      LIMIT 1
    `).bind(
      row.telegram_id,
      currentTime
    ).first();

    if (active) {
      await env.DB.prepare(`
        UPDATE subscriptions
        SET status = 'expired'
        WHERE telegram_id = ?
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at <= ?
      `).bind(
        row.telegram_id,
        currentTime
      ).run();

      continue;
    }

    try {
      await telegram("banChatMember", env, {
        chat_id: env.PRIVATE_GROUP_ID,
        user_id: row.telegram_id
      });

      await telegram("unbanChatMember", env, {
        chat_id: env.PRIVATE_GROUP_ID,
        user_id: row.telegram_id,
        only_if_banned: true
      });

    } catch (error) {
      console.error(
        "Member removal error:",
        row.telegram_id,
        error
      );
    }

    await env.DB.prepare(`
      UPDATE subscriptions
      SET status = 'expired'
      WHERE telegram_id = ?
        AND status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).bind(
      row.telegram_id,
      currentTime
    ).run();
  }
}

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

function now() {
  return Math.floor(Date.now() / 1000);
}
