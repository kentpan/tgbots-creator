# 修复 #4 机器人自定义键盘行1按钮：request_contact（无动作）→ text + create 动作
# 用户流程：点击创建API键盘 → 提示输入手机号（request_contact 键盘在流程内出现）
# 旧配置的 bug：主键盘「🗝 创建 API」是 request_contact 按钮，点击直接共享联系人，
# 落到主菜单联系人分支 → 回复「请先点击键盘创建API」→ 循环提示，创建流程永远进不去。
import json
import shutil
import sqlite3
from datetime import datetime

DB = "prisma/bot-groups.db"
SNAP = f"db-snapshots/bot4-keyboard-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"

shutil.copyfile(DB, SNAP)
print(f"snapshot -> {SNAP}")

conn = sqlite3.connect(DB)
row = conn.execute("SELECT config FROM bots WHERE id = 4").fetchone()
profile = json.loads(row[0])
tg = profile["tgapi"]
kb = tg["customKeyboard"]
row1 = kb["root"]["rows"][0]
btn = row1["buttons"][0]
print("before:", json.dumps(btn, ensure_ascii=False))

assert btn["text"] == "🗝 创建 API", "按钮文本不符，中止"

btn["kind"] = "text"
btn["action"] = {
    "type": "tgapi_func",
    "tgapi_func": "create",
    "tgapi_unlock": True,
    "tgapi_response": {
        "zh": "🗝 正在为你创建 API，请稍候…",
        "en": "🗝 Creating your API, please wait…",
    },
}
print("after:", json.dumps(btn, ensure_ascii=False))

conn.execute(
    "UPDATE bots SET config = ? WHERE id = 4",
    (json.dumps(profile, ensure_ascii=False),),
)
conn.commit()

check = json.loads(conn.execute("SELECT config FROM bots WHERE id = 4").fetchone()[0])
b1 = check["tgapi"]["customKeyboard"]["root"]["rows"][0]["buttons"][0]
assert b1["kind"] == "text" and b1["action"]["tgapi_func"] == "create"
print("verified: row1 =", json.dumps(b1, ensure_ascii=False))
conn.close()
print("OK")
