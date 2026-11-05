"""Run: python3 -m unittest discover -s tests   (from the telegram-inbox folder)"""
import sys
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import triage  # noqa: E402
from triage import MAYBE, MUST, NOISE, Config  # noqa: E402

_id = iter(range(1, 10_000))


def msg(text="", *, who="Lan", uid=11, username=None, bot=False, out=False, mentioned=False,
        reply_to_me=False, date="2026-11-04 09:00"):
    return {"id": next(_id), "date": date, "text": text, "out": out, "mentioned": mentioned,
            "reply_to_me": reply_to_me, "media": None, "forwarded": False, "link": None,
            "sender": {"id": uid, "name": who, "username": username, "bot": bot}}


def chat(kind="group", name="Ops team", **kw):
    base = {"id": -100123, "name": name, "username": None, "kind": kind, "muted": False,
            "archived": False, "pinned": False, "unread_count": 5, "unread_mentions": 0,
            "unread_mark": False, "link": None}
    return {**base, **kw}


CFG = Config(my_keywords=["Tân"], urgent_keywords=["gấp", "sự cố"],
             vip_users=["@boss"], vip_chats=["Pricing Team"], ignore_chats=["Crypto"],
             ignore_senders=["@echo_bot"])


class Tiering(unittest.TestCase):
    def tier(self, c, msgs, cfg=CFG):
        return triage.process_chat(c, msgs, cfg)

    def test_plain_group_is_maybe(self):
        self.assertEqual(self.tier(chat(), [msg("lunch?")])["tier"], MAYBE)

    def test_dm_from_human_is_must(self):
        e = self.tier(chat("dm", "Lan"), [msg("anh ơi")])
        self.assertEqual(e["tier"], MUST)
        self.assertIn("direct message", e["reasons"])

    def test_dm_from_bot_is_noise(self):
        self.assertEqual(self.tier(chat("bot", "Some bot"), [msg("hi", bot=True)])["tier"], NOISE)

    def test_mention_in_muted_group_still_must(self):
        e = self.tier(chat(muted=True), [msg("check this", mentioned=True)])
        self.assertEqual(e["tier"], MUST)
        self.assertEqual(e["reasons"], ["@mentioned you"])

    def test_reply_to_me_beats_mention_label(self):
        e = self.tier(chat(), [msg("ok", mentioned=True, reply_to_me=True)])
        self.assertEqual(e["messages"][0]["flags"], ["reply_to_me"])

    def test_muted_group_without_mention_is_noise(self):
        self.assertEqual(self.tier(chat(muted=True), [msg("blah")])["tier"], NOISE)

    def test_keyword_ignores_case(self):
        e = self.tier(chat(), [msg("hỏi TÂN xem")])
        self.assertEqual(e["tier"], MUST)
        self.assertIn("my_keyword:Tân", e["messages"][0]["flags"])

    def test_accented_keyword_does_not_hit_similar_word(self):
        # 'tấn' (tons) strips to 'tan' but must not count as the name 'Tân'
        self.assertEqual(self.tier(chat(), [msg("cần 5 tấn hàng")])["tier"], MAYBE)

    def test_ascii_keyword_still_matches_accented_text(self):
        cfg = Config(my_keywords=["tanhandle", "tan"])
        self.assertEqual(self.tier(chat(), [msg("hỏi Tân")], cfg)["tier"], MUST)

    def test_dm_with_only_service_messages_is_noise(self):
        self.assertEqual(self.tier(chat("dm", "Joined"), [])["tier"], NOISE)

    def test_keyword_needs_word_boundary(self):
        self.assertEqual(self.tier(chat(), [msg("thienthan")])["tier"], MAYBE)

    def test_vip_sender(self):
        e = self.tier(chat(), [msg("fyi", username="Boss")])
        self.assertEqual(e["tier"], MUST)

    def test_vip_chat_by_partial_name(self):
        self.assertEqual(self.tier(chat(name="Pricing Team - Hanoi"), [msg("x")])["tier"], MUST)

    def test_ignore_list_wins_over_mention(self):
        e = self.tier(chat(name="Crypto pumps"), [msg("@you", mentioned=True)])
        self.assertEqual(e["tier"], NOISE)

    def test_ignored_sender_does_not_promote(self):
        e = self.tier(chat(), [msg("deploy by Tân", username="echo_bot", bot=True)])
        self.assertEqual(e["tier"], NOISE)  # only an ignored bot spoke

    def test_unread_mentions_counter_alone_promotes(self):
        e = self.tier(chat(unread_mentions=2), [msg("x")])
        self.assertEqual(e["tier"], MUST)
        self.assertIn("2 unread mention(s)", e["reasons"])

    def test_urgent_word_keeps_maybe_with_reason(self):
        e = self.tier(chat(), [msg("có sự cố server")])
        self.assertEqual((e["tier"], e["reasons"]), (MAYBE, ["urgent word: sự cố"]))

    def test_channel_is_noise(self):
        self.assertEqual(self.tier(chat("channel", "News"), [msg("post")])["tier"], NOISE)

    def test_my_own_messages_do_not_trigger(self):
        e = self.tier(chat("dm", "Lan"), [msg("Tân here", out=True)])
        self.assertNotEqual(e["tier"], MUST)


class Selection(unittest.TestCase):
    def test_strong_messages_survive_truncation(self):
        cfg = Config(limit_maybe=2, limit_must=5)
        msgs = [msg("ping me", mentioned=True)] + [msg(f"chatter {i}") for i in range(20)]
        e = triage.process_chat(chat(), msgs, cfg)
        texts = [m["text"] for m in e["messages"]]
        self.assertIn("ping me", texts)
        self.assertEqual(e["omitted"], len(msgs) - len(texts))
        self.assertEqual(texts, sorted(texts, key=lambda t: [m["text"] for m in msgs].index(t)))


class ReportAndRender(unittest.TestCase):
    def test_order_and_render(self):
        entries = [
            triage.process_chat(chat("channel", "News", id=1), [msg("post")], CFG),
            triage.process_chat(chat(name="Ops", id=2), [msg("deploy at 5")], CFG),
            triage.process_chat(chat("dm", "Lan", id=3), [msg("anh ơi gấp")], CFG),
        ]
        rep = triage.finalize(entries, {"generated_at": "2026-11-04 09:30 +07", "mode": "unread",
                                        "me": {"name": "Tân", "username": "tanhandle"}})
        self.assertEqual([c["tier"] for c in rep["chats"]], [MUST, MAYBE, NOISE])
        self.assertEqual(rep["totals"]["unread"], 15)
        txt = triage.render_text(rep)
        self.assertIn("=== MUST · dm · Lan", txt)
        self.assertIn("untrusted data", txt)


class ConfigFile(unittest.TestCase):
    def test_example_config_loads(self):
        data = tomllib.loads((ROOT / "config.example.toml").read_text("utf-8"))
        cfg = Config.from_dict(data)
        self.assertEqual(cfg.limit_must, 40)
        self.assertEqual(cfg.scan_noise, 50)

    def test_unknown_key_is_rejected(self):
        with self.assertRaises(ValueError):
            Config.from_dict({"ignore_chat": []})


if __name__ == "__main__":
    unittest.main()
