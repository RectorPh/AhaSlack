import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from telethon import types  # noqa: E402

import tg  # noqa: E402


def test_name_tags_are_reported_with_utf16_offsets():
    m = SimpleNamespace(entities=[
        types.MessageEntityMentionName(offset=4, length=17, user_id=5673040012),
        types.MessageEntityBold(offset=0, length=3),
    ])
    assert tg.text_mentions(m) == [[4, 17, 5673040012]]
    assert tg.text_mentions(SimpleNamespace(entities=None)) == []


def test_picked_tags_parse_into_telegram_links():
    text, ents = tg.ComposerMarkdown.parse("nhờ [Mỹ Nhàn](tg://user?id=42) xem giúp")
    assert text == "nhờ Mỹ Nhàn xem giúp"
    assert [(type(e).__name__, e.url) for e in ents] == [("MessageEntityTextUrl", "tg://user?id=42")]


def test_member_search_ignores_accents():
    assert tg._fold("Mỹ Nhàn") == "my nhan" and tg._fold("Đức") == "duc"


def test_a_sent_reply_from_a_short_update_keeps_its_reply_link():
    """DMs and basic groups: Telethon gives the sent message an InputReplyToMessage."""
    from telethon import types
    import tg
    msg = types.Message(id=50, peer_id=types.PeerUser(7), message="ok", date=None, out=True,
                        reply_to=types.InputReplyToMessage(reply_to_msg_id=42))
    tg.fix_sent_reply(msg)
    assert tg.reply_target(msg) == 42 and tg.thread_top(msg) == 42
