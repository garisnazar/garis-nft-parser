const PLANS = {
  trial: { name: "Пробный 30 мин", sec: 1800, price: 0 },
  d1: { name: "1 день", sec: 86400, price: 1 },
  d7: { name: "7 дней", sec: 604800, price: 3 },
  life: { name: "Навсегда", sec: null, price: 15 },
};
const FOREVER = 9999999999;
const menu = {
  inline_keyboard: [
    [{ text: "🎁 Пробный доступ 30 мин (бесплатно)", callback_data: "p:trial" }],
    [{ text: "1 день — 1 TON", callback_data: "p:d1" }],
    [{ text: "7 дней — 3 TON", callback_data: "p:d7" }],
    [{ text: "Навсегда — 15 TON", callback_data: "p:life" }],
  ],
};
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const isAdmin = (env, id) => String(id) === env.ADMIN_ID;
const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const say = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });

async function active(env, id) {
  const r = await env.DB.prepare("SELECT expires FROM users WHERE id=?").bind(id).first();
  return !!r && r.expires > now();
}

async function grant(env, uid, key) {
  const p = PLANS[key];
  const r = await env.DB.prepare("SELECT expires FROM users WHERE id=?").bind(uid).first();
  const base = Math.max(now(), r ? r.expires : 0);
  const exp = p.sec === null ? FOREVER : base + p.sec;
  await env.DB.prepare(
    "INSERT INTO users(id,expires,kicked) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,kicked=0"
  ).bind(uid, exp).run();
  return exp;
}

function grantedMsg(env, uid, exp) {
  const until = exp >= FOREVER ? "навсегда" : "до " + new Date(exp * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " (МСК)";
  return say(env, uid, `✅ Доступ активен ${until}`, {
    reply_markup: { inline_keyboard: [[{ text: "🚪 Войти в группу", callback_data: "join" }]] },
  });
}

async function handle(u, env) {
  if (u.chat_join_request) return joinReq(u.chat_join_request, env);
  if (u.callback_query) return cb(u.callback_query, env);
  const m = u.message;
  if (!m || !m.text || m.chat.type !== "private") return;
  const uid = m.from.id;
  if (m.text.startsWith("/start")) return say(env, uid, "👋 Выберите доступ:", { reply_markup: menu });
  if (isAdmin(env, uid) && m.text.startsWith("/give")) {
    const [, id, key] = m.text.split(/\s+/);
    if (!id || !PLANS[key]) return say(env, uid, "Формат: /give USER_ID trial|d1|d7|life");
    const exp = await grant(env, +id, key);
    await grantedMsg(env, +id, exp);
    return say(env, uid, "Выдано");
  }
}

async function cb(q, env) {
  const uid = q.from.id, d = q.data;
  const ans = (text, alert) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: !!alert });

  if (d.startsWith("p:")) {
    const key = d.slice(2), p = PLANS[key];
    if (!p) return ans();
    await ans();
    if (key === "trial") {
      await env.DB.prepare("INSERT INTO users(id) VALUES(?) ON CONFLICT(id) DO NOTHING").bind(uid).run();
      const r = await env.DB.prepare("UPDATE users SET trial_used=1 WHERE id=? AND trial_used=0").bind(uid).run();
      if (!r.meta.changes) return say(env, uid, "❌ Пробный доступ уже использован.", { reply_markup: menu });
      return grantedMsg(env, uid, await grant(env, uid, "trial"));
    }
    return say(env, uid, `Тариф: <b>${p.name}</b> — <b>${p.price} TON</b>`, {
      reply_markup: { inline_keyboard: [[{ text: "💳 Оплатить", callback_data: "pay:" + key }]] },
    });
  }

  if (d.startsWith("pay:")) {
    const key = d.slice(4), p = PLANS[key];
    if (!p || !p.price) return ans();
    const ins = await env.DB.prepare("INSERT INTO orders(user_id,username,plan,price,created) VALUES(?,?,?,?,?)")
      .bind(uid, q.from.username || "", key, p.price, now()).run();
    const id = ins.meta.last_row_id;
    await ans();
    await say(env, uid, `Скиньте <b>${p.price} TON</b> на кошелёк:\n<code>${env.WALLET}</code>\n\nКомментарий к переводу: <code>#${id}</code>\nПосле проверки админом вам придёт кнопка «Войти в группу».`);
    return say(env, env.ADMIN_ID, `💰 Заявка #${id}\n${p.name} — ${p.price} TON\nЮзер: ${q.from.username ? "@" + q.from.username : "—"} (<code>${uid}</code>)\nПроверь, пришли ли TON:`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Пришли", callback_data: "ok:" + id }, { text: "❌ Нет", callback_data: "no:" + id }]] },
    });
  }

  if (d.startsWith("ok:") || d.startsWith("no:")) {
    if (!isAdmin(env, uid)) return ans("Нет прав", true);
    const id = +d.slice(3);
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND status='new'").bind(id).first();
    if (!o) return ans("Уже обработано", true);
    const edit = (text) => tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text });
    if (d[0] === "o") {
      await env.DB.prepare("UPDATE orders SET status='paid' WHERE id=?").bind(id).run();
      await grantedMsg(env, o.user_id, await grant(env, o.user_id, o.plan));
      await edit(`✅ Заявка #${id} подтверждена`);
    } else {
      await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(id).run();
      await say(env, o.user_id, "❌ Оплата не найдена. Если вы платили — напишите админу.");
      await edit(`❌ Заявка #${id} отклонена`);
    }
    return ans("Готово");
  }

  if (d === "join") {
    if (!isAdmin(env, uid) && !(await active(env, uid))) return ans("Доступ не активен. /start", true);
    const r = await tg(env, "createChatInviteLink", { chat_id: env.GROUP_ID, creates_join_request: true, expire_date: now() + 3600, name: String(uid) });
    if (!r.ok) return ans("Ошибка ссылки, напишите админу", true);
    await ans();
    return say(env, uid, "Нажмите и подайте заявку — бот её примет:", {
      reply_markup: { inline_keyboard: [[{ text: "📨 Подать заявку", url: r.result.invite_link }]] },
    });
  }

  if (d.startsWith("t:")) {
    if (!isAdmin(env, uid) && !(await active(env, uid))) return ans("Нет активного доступа", true);
    const id = +d.slice(2);
    const r = await env.DB.prepare("UPDATE gifts SET taken_by=? WHERE id=? AND taken_by IS NULL").bind(uid, id).run();
    if (!r.meta.changes) return ans("Уже занят", true);
    const g = await env.DB.prepare("SELECT * FROM gifts WHERE id=?").bind(id).first();
    await tg(env, "editMessageText", {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: g.text + "\n\n🔒 <b>Подарок занят</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
    });
    await say(env, uid, `✅ Вы заняли подарок.\nВладелец: @${esc(g.owner)}`);
    return ans("Проверьте ЛС с ботом");
  }
}

async function joinReq(j, env) {
  if (String(j.chat.id) !== String(env.GROUP_ID)) return;
  const ok = isAdmin(env, j.from.id) || (await active(env, j.from.id));
  await tg(env, ok ? "approveChatJoinRequest" : "declineChatJoinRequest", { chat_id: j.chat.id, user_id: j.from.id });
}

async function expire(env) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE expires<? AND kicked=0 LIMIT 8").bind(now()).all();
  for (const u of results) {
    await tg(env, "banChatMember", { chat_id: env.GROUP_ID, user_id: u.id });
    await tg(env, "unbanChatMember", { chat_id: env.GROUP_ID, user_id: u.id, only_if_banned: true });
    await env.DB.prepare("UPDATE users SET kicked=1 WHERE id=?").bind(u.id).run();
    await say(env, u.id, "⏰ Доступ закончился. Продлить — /start");
  }
}

// POST /publish  header: x-secret  body: {topic,name,gifts_count,premium,owner}
async function publish(req, env) {
  if (req.headers.get("x-secret") !== env.PUBLISH_SECRET) return new Response("no", { status: 403 });
  const b = await req.json();
  const th = JSON.parse(env.THREADS)[b.topic];
  if (th === undefined) return new Response("bad topic", { status: 400 });
  const text = `🎁 <b>${esc(b.name)}</b>\n📦 Подарков на аккаунте: ${esc(b.gifts_count)}\n⭐ TG Premium: ${b.premium ? "есть" : "нет"}`;
  const ins = await env.DB.prepare("INSERT INTO gifts(text,owner) VALUES(?,?)").bind(text, String(b.owner).replace("@", "")).run();
  const id = ins.meta.last_row_id;
  const r = await tg(env, "sendMessage", {
    chat_id: env.GROUP_ID, message_thread_id: th, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "✋ Занять", callback_data: "t:" + id }]] },
  });
  return Response.json(r);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("ok");
    if (new URL(req.url).pathname === "/publish") return publish(req, env);
    if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("no", { status: 403 });
    const u = await req.json();
    ctx.waitUntil(handle(u, env).catch(console.error));
    return new Response("ok");
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(expire(env));
  },
};
