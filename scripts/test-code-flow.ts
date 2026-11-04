import { loadDotEnv } from "@/lib/dotenv";
import { executeRun } from "@/database/client";
import {
  createJoinRequest,
  createVerificationSession,
  completeVerification,
  expireVerificationSession,
  getJoinRequestByToken,
  getPendingCodeContext,
  getVerificationSession,
  incrementSessionAttempts,
  isSessionExpired,
  listJoinRequests,
} from "@/database/operations";
import { utcnow } from "@/utils/time";

loadDotEnv();

const TOKEN = "smoketest-code-flow-token-0001";

async function main(): Promise<void> {
  await executeRun("DELETE FROM verification_sessions WHERE token LIKE 'smoketest-code-flow-%'");
  await executeRun("DELETE FROM join_requests WHERE verification_token LIKE 'smoketest-code-flow-%'");

  const joinRequest = await createJoinRequest({
    userId: 99000001n,
    chatId: -1009999999999n,
    username: "code_flow_user",
    firstName: "Code",
    lastName: "Flow",
    verificationToken: TOKEN,
    requestType: "telegram",
  });
  if (!joinRequest) throw new Error("createJoinRequest failed");

  const session = await createVerificationSession({
    token: TOKEN,
    userId: 99000001n,
    chatId: -1009999999999n,
    expiresAt: new Date(utcnow().getTime() + 300_000),
    method: "code_api",
  });
  if (!session || session.method !== "code_api") {
    throw new Error("createVerificationSession(method=code_api) failed");
  }

  const pending = await getPendingCodeContext(99000001n);
  if (!pending || pending.session.token !== TOKEN) {
    throw new Error("getPendingCodeContext failed");
  }

  const attempts = await incrementSessionAttempts(TOKEN);
  if (attempts !== 1) throw new Error(`attempts expected 1, got ${attempts}`);

  const completed = await completeVerification({
    token: TOKEN,
    captchaResponse: "code_api:GOOD-CODE",
    ipAddress: "127.0.0.1",
    userAgent: "smoke-test",
  });
  if (!completed) throw new Error("completeVerification failed");

  const finished = await getVerificationSession(TOKEN);
  if (!finished || !finished.captchaCompleted) {
    throw new Error("session not completed");
  }
  const joined = await getJoinRequestByToken(TOKEN);
  if (!joined || !joined.verificationCompleted) {
    throw new Error("join request not marked completed");
  }

  const duplicate = await completeVerification({
    token: TOKEN,
    captchaResponse: "code_api:AGAIN",
  });
  if (duplicate) throw new Error("duplicate completion should fail");

  const { rows, total } = await listJoinRequests({ status: "pending" });
  void rows;
  if (typeof total !== "number") throw new Error("listJoinRequests failed");

  const expireToken = "smoketest-code-flow-token-0002";
  await createJoinRequest({
    userId: 99000002n,
    chatId: -1009999999999n,
    username: "code_flow_user2",
    firstName: "Code",
    lastName: "Flow2",
    verificationToken: expireToken,
    requestType: "telegram",
  });
  await createVerificationSession({
    token: expireToken,
    userId: 99000002n,
    chatId: -1009999999999n,
    expiresAt: new Date(utcnow().getTime() + 300_000),
    method: "code_api",
  });
  await expireVerificationSession(expireToken);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await getVerificationSession(expireToken);
  if (!expired || !isSessionExpired(expired)) {
    throw new Error("expireVerificationSession failed");
  }

  console.log("CODE-API DB FLOW TEST PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
