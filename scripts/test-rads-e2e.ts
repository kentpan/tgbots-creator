import { parseCodeApiConfig, verifyCodeExternally } from "@/services/external-verify";
import { issueRadsCard } from "@/services/rads-issue";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

const BASE = "http://127.0.0.1:3001";
const ISSUE_KEY = "ak-86f5b3bc34c3ed383035e40603e159";

const radsConfig = {
  url: `${BASE}/api/redeem`,
  api_key: "rads-public-redeem",
  http_method: "POST",
  body_template: '{"key":"{{code}}"}',
  success_status: 200,
  success_field: "ok",
  success_value: "true",
  timeout_seconds: 10,
  rads_base_url: BASE,
  rads_issue_key: ISSUE_KEY,
  rads_script_id: 2,
  rads_title: "TGuard 入群验证卡",
  rads_price: 9.9,
  rads_max_uses: 3,
};

async function main(): Promise<void> {
  const parsed = parseCodeApiConfig(JSON.stringify(radsConfig));
  if (!parsed) throw new Error("config parse failed");

  console.log("[1] 管理后台发卡（issueRadsCard，与 issueCardAction 同路径）");
  const issued = await issueRadsCard(parsed);
  console.log("    ->", issued.ok ? `卡密=${issued.key} 分享链接=${issued.shareUrl}` : `失败: ${issued.message}`);
  if (!issued.ok || !issued.key) process.exit(1);

  console.log("[2] Bot 核销路径（verifyCodeExternally，与 handleCodeInput 同路径）：正确卡密");
  const good = await verifyCodeExternally(parsed, { userId: 10001n, username: "buyer01", code: issued.key });
  console.log("    ->", good.ok ? `通过: ${good.message}` : `失败: ${good.message}`);

  console.log("[3] 错误卡密");
  const bad = await verifyCodeExternally(parsed, { userId: 10001n, username: "buyer01", code: "ZZ9999XX" });
  console.log("    ->", bad.ok ? "异常：错误卡密竟通过" : `拒绝: ${bad.message}`);

  console.log("[4] 次数语义（[2]已耗 1 次；max_uses=3 → 提取页 1 次 + Bot 最后 1 次后耗尽）");
  const pageVisit = await verifyCodeExternally(parsed, { userId: 0n, username: null, code: issued.key });
  const botFirst = await verifyCodeExternally(parsed, { userId: 10001n, username: "buyer01", code: issued.key });
  const botSecond = await verifyCodeExternally(parsed, { userId: 10001n, username: "buyer01", code: issued.key });
  const botThird = await verifyCodeExternally(parsed, { userId: 10001n, username: "buyer01", code: issued.key });
  console.log("    提取页 ->", pageVisit.ok ? "自动核销通过" : `失败: ${pageVisit.message}`);
  console.log("    Bot第1次 ->", botFirst.ok ? "通过" : `拒绝: ${botFirst.message}`);
  console.log("    Bot第2次 ->", botSecond.ok ? "异常：额度已耗尽竟通过" : `拒绝: ${botSecond.message}`);
  console.log("    Bot第3次 ->", botThird.ok ? "异常：额度已耗尽竟通过" : `拒绝: ${botThird.message}`);

  console.log("[5] 发卡失败路径（无效 script_id）");
  const badIssue = await issueRadsCard(parsed, { scriptId: 999 });
  console.log("    ->", badIssue.ok ? "异常：无效资源竟发卡成功" : `拒绝: ${badIssue.message}`);

  const allOk =
    good.ok && !bad.ok && pageVisit.ok && botFirst.ok && !botSecond.ok && !botThird.ok && !badIssue.ok;
  console.log(allOk ? "E2E RESULT: ALL PASS" : "E2E RESULT: FAILED");
  if (!allOk) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
