
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "Garis NFT Parser"
      });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
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
      console.error("Update error:", error);
    }

    return new Response("OK");
  },

  async scheduled(controller, env) {
    await expireSubscriptions(env);
  }
};

async function telegram(method, env, body = {}) {
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

  if (!result.ok) {
    throw new Error(
      `Telegram ${method}: ${result.description}`
    );
  }

  return result.result;
}

async function sendMessage(chatId, text, env, keyboard) {
  return telegram("sendMessage", env, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

async function answerCallback(id, env, text = "") {
  return telegram("answerCallbackQuery", env, {
    callback_query_id: id,
    text
  });
}

async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text || "";

  if (!user || chatId !== user.id) return;

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
    Math.floor(Date.now() / 1000)
  ).run();

  if (text.startsWith("/start")) {
    return showMenu(chatId, env);
  }

  if (text === "/paysupport") {
    return sendMessage(
      chatId,
      "💬 Поддержка Garis NFT Parser\n\nНапишите администратору: " +
      (env.SUPPORT_USERNAME
        ? `@${env.SUPPORT_USERNAME}`
        : "контакт поддержки пока не настроен"),
      env
    );
  }

  if (text === "/myaccess") {
    return showAccess(chatId, env);
  }
}

async function showMenu(chatId, env) {
  return sendMessage(
    chatId,
    "💎 <b>Garis NFT Parser</b>\n\n" +
    "Автоматический мониторинг доступных Telegram NFT.\n\n" +
    "Выберите тариф:",
    env,
    {
      inline_keyboard: [
        [{
          text: "🎁 Бесплатно — 30 минут",
          callback_data: "trial"
        }],
        [{
          text: "1 день",
          callback_data: "plan:day"
        }],
        [{
          text: "7 дней",
          callback_data: "plan:week"
        }],
        [{
          text: "♾ Навсегда",
          callback_data: "plan:forever"
        }],
        [{
          text: "📊 Мой доступ",
          callback_data: "access"
        }]
      ]
    }
  );
}

async function handleCallback(query, env) {
  const data = query.data || "";
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  await answerCallback(query.id, env);

  if (data === "trial") {
    return activateTrial(userId, chatId, env);
  }

  if (data === "access") {
    return showAccess(chatId, env);
  }

  if (data.startsWith("plan:")) {
    const plan = data.split(":")[1];
    return createOrder(userId, chatId, plan, env);
  }
}

async function activateTrial(userId, chatId, env) {
  const now = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(`
    UPDATE users
    SET trial_used = 1
    WHERE telegram_id = ?
    AND trial_used = 0
  `).bind(userId).run();

  if (result.meta.changes !== 1) {
    return sendMessage(
      chatId,
      "❌ Пробный доступ уже использован.",
      env
    );
  }

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
    now,
    now + TRIAL_SECONDS
  ).run();

  await sendJoinLink(userId, chatId, now + TRIAL_SECONDS, env);
}

async function createOrder(userId, chatId, planName, env) {
  const plan = PLANS[planName];

  if (!plan) return;

  const price = Number(env[plan.priceKey]);

  if (!Number.isInteger(price) || price <= 0) {
    return sendMessage(
      chatId,
      "⚙️ Этот тариф пока не настроен администратором.",
      env
    );
  }

  const orderId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

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
    now
  ).run();

  await telegram("sendInvoice", env, {
    chat_id: chatId,
    title: `Garis NFT Parser — ${plan.name}`,
    description: `Доступ к Garis NFT Parser: ${plan.name}`,
    payload: orderId,
    currency: "XTR",
    prices: [{
      label: plan.name,
      amount: price
    }]
  });
}

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
    ...(!order ? {
      error_message: "Счёт недействителен или уже использован."
    } : {})
  });
}

async function handleSuccessfulPayment(message, env) {
  const payment = message.successful_payment;
  const userId = message.from.id;
  const orderId = payment.invoice_payload;
  const now = Math.floor(Date.now() / 1000);

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
    console.error("Unknown or already processed payment", orderId);
    return;
  }

  const plan = PLANS[order.plan];

  if (!plan) return;

  const current = await env.DB.prepare(`
    SELECT MAX(expires_at) AS expiry
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND expires_at > ?
  `).bind(userId, now).first();

  const currentExpiry = current?.expiry || now;

  const expiresAt = plan.seconds
    ? currentExpiry + plan.seconds
    : null;

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE orders
      SET status = 'paid',
          telegram_charge_id = ?
      WHERE id = ?
        AND status = 'pending'
    `).bind(payment.telegram_payment_charge_id, orderId),

    env.DB.prepare(`
      INSERT INTO subscriptions (
        telegram_id,
        plan,
        starts_at,
        expires_at,
        status
      )
      VALUES (?, ?, ?, ?, 'active')
    `).bind(userId, order.plan, now, expiresAt)
  ]);

  await sendJoinLink(userId, message.chat.id, expiresAt, env);

  await sendMessage(
    message.chat.id,
    "✅ <b>Оплата получена!</b>\n\n" +
    "Тариф: " + plan.name + "\n" +
    "Доступ активирован.",
    env
  );
}

async function sendJoinLink(userId, chatId, expiresAt, env) {
  if (!env.PRIVATE_GROUP_ID) {
    return sendMessage(
      chatId,
      "✅ Доступ активирован. Группа ещё не настроена.",
      env
    );
  }

  const body = {
    chat_id: env.PRIVATE_GROUP_ID,
    member_limit: 1,
    name: `Garis-${userId}-${Date.now()}`
  };

  if (expiresAt) {
    body.expire_date = expiresAt;
  }

  const invite = await telegram(
    "createChatInviteLink",
    env,
    body
  );

  return sendMessage(
    chatId,
    "🎉 <b>Твой доступ активирован!</b>\n\n" +
    "Нажми кнопку ниже, чтобы войти в закрытую группу.",
    env,
    {
      inline_keyboard: [[{
        text: "🚀 Войти в группу",
        url: invite.invite_link
      }]]
    }
  );
}

async function showAccess(chatId, env) {
  const now = Math.floor(Date.now() / 1000);

  const subscription = await env.DB.prepare(`
    SELECT plan, expires_at
    FROM subscriptions
    WHERE telegram_id = ?
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY expires_at DESC
    LIMIT 1
  `).bind(chatId, now).first();

  if (!subscription) {
    return sendMessage(
      chatId,
      "У тебя нет активной подписки.\n\n/start — выбрать тариф.",
      env
    );
  }

  const expiry = subscription.expires_at
    ? new Date(subscription.expires_at * 1000).toLocaleString("ru-RU")
    : "Бессрочно";

  return sendMessage(
    chatId,
    `✅ Доступ активен\n\nТариф: ${subscription.plan}\nДо: ${expiry}`,
    env
  );
}

async function expireSubscriptions(env) {
  const now = Math.floor(Date.now() / 1000);

  const expired = await env.DB.prepare(`
    SELECT DISTINCT telegram_id
    FROM subscriptions
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).bind(now).all();

  for (const row of expired.results || []) {
    const active = await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE telegram_id = ?
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1
    `).bind(row.telegram_id, now).first();

    if (active) continue;

    if (env.PRIVATE_GROUP_ID) {
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
        console.error("Could not remove member:", error);
      }
    }

    await env.DB.prepare(`
      UPDATE subscriptions
      SET status = 'expired'
      WHERE telegram_id = ?
        AND status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).bind(row.telegram_id, now).run();
  }
}
