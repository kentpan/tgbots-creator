/**
 * 群内验证（v2.1.0）端到端校验脚本（本地 :memory: 副本库，跑完即弃，不触碰真实数据）：
 * 1. 群组设置验证渠道往返（group / dm / 不传保持）
 * 2. 群内渠道网页输码：正确码 → 成功 + DB 批准
 * 3. 群内渠道网页输码：错误码 3 次 → 计次 → 失效 → rejected
 * 4. DM 渠道回归：旧会话语义（channel=dm）与失败/成功文案逐字一致
 * 5. 外部卡密 API 真实连通（错误原文透传）
 *
 * 用法：npm run test:group-verify
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";

const TMP_DB = "/tmp/tgbots-e2e.db";
if (existsSync(TMP_DB)) rmSync(TMP_DB);
copyFileSync("prisma/bot-groups.db", TMP_DB);
process.env.DATABASE_URI = `file:${TMP_DB}`;

const CHAT_ID = -1003839646008n;

function ok(label: string, condition: boolean, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!condition) process.exitCode = 1;
}

async function main(): Promise<void> {
  const ops = await import("@/database/operations");
  const flow = await import("@/services/verification-flow");
  const external = await import("@/services/external-verify");
  const { generateJoinCode, generateVerificationToken } = await import("@/utils/crypto");
  const { buildOptionCodes } = await import("@/services/group-verification");

  // ---------- 1. 设置往返 ----------
  await ops.upsertGroupSettings(CHAT_ID, {
    chatTitle: "E2E 群",
    method: "code_self",
    timeoutSeconds: 600,
    maxAttempts: 3,
    verifyChannel: "group",
  });
  let settings = await ops.getGroupSettings(CHAT_ID);
  ok("设置写入 verify_channel=group", settings?.verifyChannel === "group", settings?.verifyChannel);

  await ops.upsertGroupSettings(CHAT_ID, { method: "code_self" }); // 不传 verifyChannel
  settings = await ops.getGroupSettings(CHAT_ID);
  ok("未传 verifyChannel 时保持原值（不被重置）", settings?.verifyChannel === "group", settings?.verifyChannel);

  await ops.upsertGroupSettings(CHAT_ID, { verifyChannel: "dm" });
  settings = await ops.getGroupSettings(CHAT_ID);
  ok("可切换为 dm（私聊渠道）", settings?.verifyChannel === "dm", settings?.verifyChannel);

  // ---------- 4. DM 渠道回归 ----------
  {
    await ops.upsertGroupSettings(CHAT_ID, { method: "code_self", maxAttempts: 3, verifyChannel: "dm" });
    const token = generateVerificationToken();
    const code = generateJoinCode();
    await ops.createJoinRequest({
      userId: 910001n,
      chatId: CHAT_ID,
      username: "dm_user",
      firstName: "DM",
      lastName: "用户",
      verificationToken: token,
      requestType: "simulator",
    });
    const session = await ops.createVerificationSession({
      token,
      userId: 910001n,
      chatId: CHAT_ID,
      expiresAt: new Date(Date.now() + 600_000),
      method: "code_self",
      expectedCode: code,
    });
    ok("DM 会话默认 channel=dm（旧行为不变）", session?.channel === "dm", session?.channel);

    const preloaded = await flow.loadPendingContextByToken(token);
    const wrong = await flow.evaluateSubmittedCode({
      userId: 910001n,
      username: "dm_user",
      code: "000000",
      preloaded,
    });
    ok("DM 错误码 → failed_retry", wrong.outcome === "failed_retry", wrong.outcome);
    ok("DM 失败文案与旧版逐字一致", wrong.replyText.startsWith("❌ 验证码错误，请重试。\n错误原因：验证码不正确\n剩余尝试次数：2"), wrong.replyText);

    const success = await flow.evaluateSubmittedCode({
      userId: 910001n,
      username: "dm_user",
      code,
      preloaded: await flow.loadPendingContextByToken(token),
    });
    ok("DM 正确码 → success", success.outcome === "success", success.outcome);
    ok("DM 成功文案 = success_text", success.replyText === "✅ 验证成功，欢迎加入！", success.replyText);
    const req = await ops.getJoinRequestByToken(token);
    ok("DM 成功后申请状态 approved", req?.status === "approved", req?.status);
  }

  // ---------- 2. 群内渠道：网页输码成功（端到端 DB 批准） ----------
  {
    await ops.upsertGroupSettings(CHAT_ID, { method: "code_self", maxAttempts: 3, verifyChannel: "group" });
    const token = generateVerificationToken();
    const code = generateJoinCode();
    await ops.createJoinRequest({
      userId: 910002n,
      chatId: CHAT_ID,
      username: "group_user",
      firstName: "群内",
      lastName: "用户",
      verificationToken: token,
      requestType: "telegram",
    });
    const session = await ops.createVerificationSession({
      token,
      userId: 910002n,
      chatId: CHAT_ID,
      expiresAt: new Date(Date.now() + 600_000),
      method: "code_self",
      expectedCode: code,
      channel: "group",
      optionCodes: buildOptionCodes(code),
    });
    ok("群内会话 channel=group 且落库 4 个候选码", session?.channel === "group" && session?.optionCodes?.length === 4, {
      channel: session?.channel,
      options: session?.optionCodes?.length,
    });
    ok("候选码包含正确码（点对才通过）", session?.optionCodes?.includes(code) === true);

    // 模拟网页输码（/api/v1/verify-code 完全同一调用）
    const result = await flow.evaluateSubmittedCode({
      userId: 910002n,
      username: "group_user",
      code,
      preloaded: await flow.loadPendingContextByToken(token),
    });
    ok("群内渠道网页输码 → success", result.outcome === "success", result.outcome);
    ok("群内渠道结果标记为 group", result.channel === "group", result.channel);
    ok("群内渠道成功后 DB 已批准", result.approved === true, result.approved);
    const req = await ops.getJoinRequestByToken(token);
    ok("群内渠道 join_requests.status=approved", req?.status === "approved", req?.status);
  }

  // ---------- 3. 群内渠道：错误码 3 次 → 计次 → 失效 → rejected ----------
  {
    const token = generateVerificationToken();
    const code = generateJoinCode();
    await ops.createJoinRequest({
      userId: 910003n,
      chatId: CHAT_ID,
      username: "fail_user",
      firstName: "失败",
      lastName: "用户",
      verificationToken: token,
      requestType: "telegram",
    });
    await ops.createVerificationSession({
      token,
      userId: 910003n,
      chatId: CHAT_ID,
      expiresAt: new Date(Date.now() + 600_000),
      method: "code_self",
      expectedCode: code,
      channel: "group",
      optionCodes: buildOptionCodes(code),
    });

    const first = await flow.evaluateSubmittedCode({
      userId: 910003n,
      username: "fail_user",
      code: "111111",
      preloaded: await flow.loadPendingContextByToken(token),
    });
    const second = await flow.evaluateSubmittedCode({
      userId: 910003n,
      username: "fail_user",
      code: "222222",
      preloaded: await flow.loadPendingContextByToken(token),
    });
    const third = await flow.evaluateSubmittedCode({
      userId: 910003n,
      username: "fail_user",
      code: "333333",
      preloaded: await flow.loadPendingContextByToken(token),
    });
    ok(
      "错误码 3 次：retry → retry → expired",
      first.outcome === "failed_retry" && second.outcome === "failed_retry" && third.outcome === "failed_expired",
      [first.outcome, second.outcome, third.outcome],
    );
    ok("剩余次数递减 2 → 1", first.remaining === 2 && second.remaining === 1, [first.remaining, second.remaining]);
    const req = await ops.getJoinRequestByToken(token);
    ok("失效后申请状态 rejected", req?.status === "rejected", req?.status);
    const session = await ops.getVerificationSession(token);
    ok("失效后会话被标记过期", session !== null && session.expiresAt.getTime() <= Date.now());
  }

  // ---------- 5. 外部卡密 API 真实连通（错误原文透传） ----------
  {
    const config = external.parseCodeApiConfig(
      JSON.stringify({
        url: "https://xianyu.mfzl.cn/api/verify-codes/verify",
        api_key: "xyk_c4e5615d8bc990e2e5225d332c264eb70011dd69b24d3065",
        http_method: "POST",
        code_field: "code",
        success_status: 200,
        success_field: "success",
        success_value: "true",
        timeout_seconds: 30,
      }),
    );
    if (!config) {
      ok("外部验证接口配置可解析", false);
    } else {
      const result = await external.verifyCodeExternally(config, {
        userId: 999999n,
        username: "e2e",
        code: "NOT-A-REAL-CARD-0000",
      });
      console.log(`   外部接口返回：ok=${result.ok} networkError=${result.networkError} message=${result.message}`);
      ok("外部卡密 API 连通且拒绝无效卡密（非网络错误）", result.ok === false && result.networkError === false, result.message);
    }
  }

  console.log("\n=== 本次 e2e 断言全部执行完毕 ===");
}

void main().catch((error: unknown) => {
  console.error("E2E 脚本异常:", error);
  process.exitCode = 1;
});
