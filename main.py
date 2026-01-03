import os
import sys
import base64
from pathlib import Path
from typing import Any, Optional
from datetime import datetime
import json
import io
from pydub import AudioSegment
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from loguru import logger
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from dotenv import load_dotenv
import asyncio
import time

from log_config import LogConfig, logger  # use centralized logging

# Configuration
LOG_DIR = Path("logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)
GLOBAL_LOG_FILE = LOG_DIR / "all_sessions.log"

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
MODEL_ID = os.getenv("MODEL_ID", "gemini-flash-lite-latest")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "180"))
MAX_CONCURRENT_ANALYSES = int(os.getenv("MAX_CONCURRENT_ANALYSES", "3"))

if not GOOGLE_API_KEY:
    raise ValueError("GOOGLE_API_KEY not found in .env file")

# Logging setup
logger.remove()
logger.add(
    GLOBAL_LOG_FILE,
    format="<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | <level>{message}</level>",
    level="DEBUG",
    rotation="10 MB",
    retention="10 days",
    compression="zip",
    enqueue=True
)
logger.add(
    sys.stdout,
    format="<green>{time:HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | <cyan>{function: <20}</cyan> | <level>{message}</level>",
    level="INFO",
    colorize=True
)

LogConfig.setup()
logger.info(f"🚀 Starting AI Session Analyzer Backend v1.0.0")
logger.info(f"🔧 Model: {MODEL_ID} | Timeout: {LLM_TIMEOUT}s | Max Concurrent: {MAX_CONCURRENT_ANALYSES}")

app = FastAPI(title="AI Session Analyzer Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SessionReportOutput(BaseModel):
    title: str = Field(description="Efficient, concise title for the session")
    session_report: str = Field(description="Full structured markdown report with analysis")

class AnalyzeBase64Request(BaseModel):
    session_id: str
    mime_type: str = "audio/webm"
    audio_base64: str
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    duration_minutes: Optional[float] = None

LLM_CLIENT = ChatGoogleGenerativeAI(
    model=MODEL_ID,
    temperature=0.2,
    max_retries=2,
    timeout=LLM_TIMEOUT,
    google_api_key=GOOGLE_API_KEY,
)
STRUCTURED_LLM = LLM_CLIENT.with_structured_output(SessionReportOutput)
ANALYSIS_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_ANALYSES)

def _normalize_structured_output(result: Any) -> Optional[dict]:
    if result is None:
        return None
    if isinstance(result, SessionReportOutput):
        normalized = result.model_dump()
    elif isinstance(result, BaseModel):
        normalized = result.model_dump()
    elif isinstance(result, dict):
        normalized = dict(result)
    else:
        return None
    return normalized if normalized.get("title") and normalized.get("session_report") else None

def _parse_json_from_text(raw_output: Any) -> Optional[dict]:
    if raw_output is None:
        return None
    if isinstance(raw_output, BaseModel):
        candidate = raw_output.model_dump()
        return candidate if candidate.get("title") and candidate.get("session_report") else None
    if isinstance(raw_output, dict):
        return raw_output if raw_output.get("title") and raw_output.get("session_report") else None

    if isinstance(raw_output, AIMessage):
        content = raw_output.content
    elif isinstance(raw_output, str):
        content = raw_output
    else:
        content = getattr(raw_output, "content", None) or str(raw_output)

    if not content:
        return None

    text = content.strip()
    if text.startswith("```"):
        stripped = text.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        text = stripped or text

    try:
        candidate = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            candidate = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None

    return candidate if candidate.get("title") and candidate.get("session_report") else None

async def get_session_report(audio_base64: str, mime_type: str, duration_minutes: float = 0.0, session_logger=None) -> dict:
    log = session_logger or logger
    start_time = time.time()
    LogConfig.log_event(log, "analysis_started", level="INFO", audio_chars=len(audio_base64), mime_type=mime_type, duration_minutes=duration_minutes)
    if len(audio_base64) < 1000:
        LogConfig.log_event(log, "audio_too_small", level="WARNING", size=len(audio_base64))
        return {"title": "جلسه کوتاه", "session_report": "خطا: فایل صوتی بسیار کوتاه است.", "status": "error"}

    system_instruction = """
شما یک خلاصهگر حرفهای جلسات تجاری هستید. وظیفه شما تولید یک گزارش ساختاریافته و دقیق از صوت ورودی مطابق اسکیمای خروجی است.
first analyze all session voice so correctly and in detail and analyze each person voice and diffrent persons and all session voice content carefully 
همچنین مدت زمان دقیق جلسه به صورت متن در کنار فایل صوتی برای شما ارسال شده است که باید در گزارش لحاظ شود.
دستورالعملها:
- خروجی فقط باید یک شیء JSON مطابق اسکیمای داده شده باشد؛ هیچ متن اضافی یا توضیحی ارسال نکنید.
- اگر زبان صوت فارسی بود، خروجی را به فارسی حرفهای و مختصر بنویسید؛ اگر زبان دیگری بود، خروجی را به انگلیسی بنویسید.
- کل محتوای نهایی و جواب نهایی فقط به یک زبان نوشته شود (زبان اصلی جلسه)
- از ایموجی های مرتبط و میمنیمال و زیبا با هر عنوان ور قسمت استفاده کن حتما برای جذابیت بشتر متن
- از تمام المان های مارک داون برای خوانایی بهتر و زیبایی بیشتر نتیجه نهایی استفاده کن با ایموجی های مرتبط
- فیلدها:(در صورت نیاز میتونی از فیلدهای زیر استفاده کنی ولی حواست باشه تو باید خلاصه جلسه رو کامل و متناسب با محتوای جلسه بنویسی و اگه نیاز بود از فیلد های دیگر هم خودت بسار و ساتفاده کن )
1. title
- عنوان بسیار خلاصه، شفاف و کاربردی
- حداکثر ۱۰ کلمه
- تمرکز بر «موضوع اصلی تصمیمگیری یا هدف جلسه

2. session_report (Markdown)
گزارش جلسه را دقیقاً با ساختار زیر تولید کن:
ا
## خلاصه جلسه

- موضوع اصلی جلسه
- اعضای شرکت کننده در هر جلسه 
- مقدار زمان جلسه به دقیقه
- نمره اهمیت جلسه از یک تا صد
- فرد تاثیر گذار و برتر جلسه

## صورت جلسه
- نکات و گزارش کلی جلسه در ابتدا در یک پاراگراف
- گروه بندی طبق صحبت های هر فرد جدا گانه
- نکات مهم عنوان شده توسط هر فرد
- فقط اطلاعات اثرگذار (حذف حاشیهها)
- نمره به هر فرد طبق اثر گذاری و مقدار شرکت در جلسه و نکات کلیدی مطرح شده توسط او و رتبه بندی اعضا طبق نمره


## اقدامات و تصمیمات نهایی و تسک های هر فرد

- تصمیمات و اقدامات کلی تیم در ابتدا
- بعد اقدامات و تسک های مربوط به هر فرد جداگانه
- هر آیتم اکشن بهصورت بولت:
  - شرح اقدام
  - مالک (Owner)
  - مهلت انجام (Deadline)
- اگر مالک یا مهلت ذکر نشده بود → «ذکر نشده»

- ساختار گزارش باید واضح، طبقهبندیشده و با بولتپوینتها باشد. از ایموجیهای مرتبط بهصورت محدود و حرفهای استفاده کنید.
- آیتمهای اکشن را با ذکر مالک و ددلاین (در صورت وجود) بهصورت شفاف استخراج کنید.
- اگر بخشی از صوت نامشخص یا مبهم بود، آن را با عبارت "نامشخص" یا "ذکر نشده" مشخص کنید.
- از تکرار یا حاشیهروی پرهیز کنید و فقط اطلاعات مهم و کاربردی را استخراج نمایید.
"""
    
    log.info("🤖 Preparing LLM invocation")
    system_msg = SystemMessage(content=system_instruction)
    
    # Add duration as text part alongside audio
    duration_text = f"مدت زمان کل این جلسه: {duration_minutes:.2f} دقیقه است."
    
    audio_msg = HumanMessage(
        content=[
            {"type": "text", "text": duration_text},
            {
                "type": "file",
                "source_type": "base64",
                "mime_type": mime_type,
                "data": audio_base64,
            }
        ]
    )
    llm_messages = [system_msg, audio_msg]
    fallback_prompt = HumanMessage(
        content="Return ONLY a valid JSON object with keys 'title' and 'session_report'. Use the session language."
    )
    try:
        LogConfig.log_event(log, "llm_waiting_slot", level="DEBUG", concurrent_limit=MAX_CONCURRENT_ANALYSES)
        async with ANALYSIS_SEMAPHORE:
            LogConfig.log_event(log, "llm_slot_acquired", level="DEBUG", available_slots=ANALYSIS_SEMAPHORE._value)
            # Log the full prompt at INFO level so it appears in console
            LogConfig.log_ai_prompt(log, llm_messages, level="INFO")
            invoke_start = time.time()
            result = await asyncio.wait_for(asyncio.to_thread(STRUCTURED_LLM.invoke, llm_messages), timeout=LLM_TIMEOUT)
            LogConfig.log_event(log, "llm_structured_raw_output", level="DEBUG", raw_output=result)
            LogConfig.log_event(log, "llm_structured_duration", level="DEBUG", seconds=time.time() - invoke_start)
        normalized = _normalize_structured_output(result)
        if not normalized:
            LogConfig.log_event(log, "llm_structured_invalid", level="WARNING")
            async with ANALYSIS_SEMAPHORE:
                LogConfig.log_event(log, "llm_fallback_slot_acquired", level="DEBUG", available_slots=ANALYSIS_SEMAPHORE._value)
                fallback_messages = llm_messages + [fallback_prompt]
                LogConfig.log_ai_prompt(log, fallback_messages, level="INFO")
                fallback_start = time.time()
                fallback_result = await asyncio.wait_for(
                    asyncio.to_thread(LLM_CLIENT.invoke, fallback_messages),
                    timeout=LLM_TIMEOUT,
                )
                LogConfig.log_event(log, "llm_fallback_raw_output", level="DEBUG", raw_output=fallback_result)
                LogConfig.log_event(log, "llm_fallback_duration", level="DEBUG", seconds=time.time() - fallback_start)
            normalized = _parse_json_from_text(fallback_result)

        if not normalized:
            LogConfig.log_event(log, "llm_output_missing_fields", level="ERROR")
            return {"title": "خطا در تحلیل", "session_report": "مدل نتوانست خروجی معتبری برگرداند.", "status": "error"}

        normalized["status"] = "ok"
        LogConfig.log_event(log, "llm_normalized_output", level="INFO", report=normalized)
        LogConfig.log_event(log, "analysis_completed", level="INFO", duration=time.time() - start_time)
        return normalized

    except asyncio.TimeoutError:
        LogConfig.log_event(log, "llm_timeout", level="ERROR", timeout=LLM_TIMEOUT)
        return {"title": "خطا در تحلیل (Timeout)", "session_report": "تحلیل صدا زمانبر بود و کامل نشد.", "status": "error"}
    except Exception as e:
        LogConfig.log_event(log, "llm_exception", level="ERROR", error=str(e))
        return {"title": "خطا در تحلیل", "session_report": f"خطا در تحلیل صدا: {str(e)}", "status": "error"}

@app.get("/health")
def health():
    logger.info("💚 Health check requested")
    return {"ok": True, "model": MODEL_ID, "api_key_set": bool(GOOGLE_API_KEY)}

def _sanitize_for_fs(raw: Optional[str], fallback: str) -> str:
    safe = "".join(ch for ch in (raw or "") if ch.isalnum() or ch in ("-", "_"))
    return safe or fallback

MIME_EXTENSION_MAP = {
    "audio/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/m4a": ".m4a",
    "audio/aac": ".aac",
}

def _extension_from_mime(mime_type: Optional[str]) -> str:
    return MIME_EXTENSION_MAP.get((mime_type or "").lower(), ".webm")

def _ensure_user_dir(req: AnalyzeBase64Request) -> Path:
    base_dir = Path("database")
    user_id = _sanitize_for_fs(req.user_id or req.session_id, "anonymous")
    user_name = _sanitize_for_fs(req.user_name or "user", "user")
    target_dir = base_dir / f"{user_id}__{user_name}"
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir

def save_session_audio(req: AnalyzeBase64Request) -> dict:
    logger.debug(f"💾 Saving audio for session {req.session_id}")
    target_dir = _ensure_user_dir(req)
    
    try:
        audio_bytes = base64.b64decode(req.audio_base64)
        logger.debug(f"✅ Decoded {len(audio_bytes)} bytes")
    except Exception as exc:
        logger.error(f"❌ Base64 decode failed: {exc}")
        raise ValueError(f"Invalid base64 audio payload: {exc}") from exc

    extension = _extension_from_mime(req.mime_type)
    session_slug = _sanitize_for_fs(req.session_id, "session")
    audio_path = target_dir / f"{session_slug}{extension}"
    
    with open(audio_path, "wb") as audio_file:
        audio_file.write(audio_bytes)
    
    logger.info(f"💾 Audio saved: {audio_path} ({len(audio_bytes)/1024/1024:.2f} MB)")

    return {
        "path": audio_path,
        "filename": audio_path.name,
        "mime_type": req.mime_type or "audio/webm",
        "size_bytes": len(audio_bytes),
        "directory": target_dir,
    }

def save_session_report(req: AnalyzeBase64Request, report: dict, audio_meta: Optional[dict] = None) -> Path:
    logger.debug(f"💾 Saving report for session {req.session_id}")
    target_dir = _ensure_user_dir(req)
    session_slug = _sanitize_for_fs(req.session_id, "session")
    
    payload = {
        "session_id": req.session_id,
        "user_id": _sanitize_for_fs(req.user_id or req.session_id, "anonymous"),
        "user_name": _sanitize_for_fs(req.user_name or "user", "user"),
        "created_at": datetime.utcnow().isoformat() + "Z",
        "status": report.get("status", "error"),
        "title": report.get("title"),
        "session_report": report.get("session_report"),
    }
    
    if audio_meta:
        payload["audio_file"] = audio_meta.get("filename")
        payload["audio_mime_type"] = audio_meta.get("mime_type")
        payload["audio_size_bytes"] = audio_meta.get("size_bytes")
    
    out_file = target_dir / f"{session_slug}.json"
    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    
    logger.info(f"💾 Report saved: {out_file}")
    return out_file

@app.post("/analyze_base64")
async def analyze_base64(req: AnalyzeBase64Request, request: Request):
    request_start = time.time()
    with LogConfig.session_context(req.session_id) as session_logger:
        LogConfig.log_event(
            session_logger,
            "request_received",
            level="INFO",
            user_id=req.user_id,
            user_name=req.user_name,
            audio_megabytes=len(req.audio_base64) / 1024 / 1024,
            client_ip=(request.client.host if request.client else "unknown"),
        )
        try:
            # Extract duration using pydub if not provided
            duration_minutes = req.duration_minutes
            if duration_minutes is None:
                try:
                    audio_bytes = base64.b64decode(req.audio_base64)
                    audio_format = req.mime_type.split('/')[-1] if '/' in req.mime_type else "webm"
                    if "mpeg" in audio_format or "mp3" in audio_format: audio_format = "mp3"
                    audio_segment = AudioSegment.from_file(io.BytesIO(audio_bytes), format=audio_format)
                    duration_minutes = len(audio_segment) / 60000.0
                    LogConfig.log_event(session_logger, "duration_extracted", level="INFO", minutes=duration_minutes)
                except Exception as e:
                    logger.warning(f"Duration extraction failed: {e}")
                    duration_minutes = 0.0

            audio_meta = await asyncio.to_thread(save_session_audio, req)
            LogConfig.log_event(session_logger, "audio_saved", level="INFO", audio_meta=audio_meta)
            report = await get_session_report(req.audio_base64, req.mime_type, duration_minutes=duration_minutes, session_logger=session_logger)
            report_path = await asyncio.to_thread(save_session_report, req, report, audio_meta=audio_meta)
            LogConfig.log_event(session_logger, "report_persisted", level="INFO", path=str(report_path), report=report)
            request_duration = time.time() - request_start
            session_logger.success(f"✅ Request completed in {request_duration:.2f}s | status={report.get('status')}")
            LogConfig.log_event(session_logger, "request_completed", level="INFO", duration=request_duration, status=report.get("status"))
            logger.info(f"📊 Session {req.session_id} | Status: {report.get('status')} | Duration: {request_duration:.2f}s")
            logger.debug(f"📝 Title: {report.get('title')}")
            return {
                "session_id": req.session_id,
                "model": MODEL_ID,
                "title": report.get("title"),
                "session_report": report.get("session_report"),
                "status": report.get("status", "error"),
                "processing_time": round(request_duration, 2)
            }
        except Exception as e:
            request_duration = time.time() - request_start
            LogConfig.log_event(session_logger, "request_failed", level="ERROR", duration=request_duration, error=str(e))
            session_logger.exception(f"❌ Error after {request_duration:.2f}s: {e}")
            logger.error(f"❌ Session {req.session_id} failed: {e}")
            return {
                "session_id": req.session_id,
                "model": MODEL_ID,
                "error": str(e),
                "status": "error",
                "processing_time": round(request_duration, 2)
            }

@app.get("/session_audio/{user_id}/{session_id}")
def get_session_audio(user_id: str, session_id: str):
    logger.info(f"📥 Audio retrieval request | user_id={user_id} | session_id={session_id}")
    
    base_dir = Path("database")
    safe_user_id = _sanitize_for_fs(user_id, "anonymous")
    matches = sorted(base_dir.glob(f"{safe_user_id}__*"))
    
    if not matches:
        logger.warning(f"⚠️ User not found: {user_id}")
        raise HTTPException(status_code=404, detail="User not found")
    
    user_dir = matches[0]
    session_slug = _sanitize_for_fs(session_id, session_id)
    meta_path = user_dir / f"{session_slug}.json"
    
    if not meta_path.exists():
        logger.warning(f"⚠️ Session metadata not found: {session_id}")
        raise HTTPException(status_code=404, detail="Session metadata not found")

    with open(meta_path, "r", encoding="utf-8") as fh:
        metadata = json.load(fh)

    audio_filename = metadata.get("audio_file")
    if not audio_filename:
        logger.error(f"❌ No audio file in metadata for session {session_id}")
        raise HTTPException(status_code=404, detail="Audio file missing")
    
    audio_path = user_dir / audio_filename
    if not audio_path.exists():
        logger.error(f"❌ Audio file not found: {audio_path}")
        raise HTTPException(status_code=404, detail="Audio file not found")

    with open(audio_path, "rb") as audio_fh:
        audio_bytes = audio_fh.read()
    
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    logger.info(f"✅ Audio retrieved: {audio_filename} ({len(audio_bytes)/1024/1024:.2f} MB)")

    return {
        "session_id": session_id,
        "user_id": metadata.get("user_id"),
        "user_name": metadata.get("user_name"),
        "mime_type": metadata.get("audio_mime_type", "audio/webm"),
        "audio_base64": audio_base64,
        "size_bytes": len(audio_bytes),
    }

async def test_with_audio_file(audio_path: str):
    logger.info(f"\n{'='*80}\n🧪 TEST MODE - Analyzing: {audio_path}\n{'='*80}")
    
    audio_file = Path(audio_path)
    if not audio_file.exists():
        logger.error(f"❌ File not found: {audio_path}")
        return
    
    with open(audio_file, "rb") as f:
        audio_bytes = f.read()
    
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    logger.info(f"📦 Size: {len(audio_bytes)/1024/1024:.2f} MB | Base64: {len(audio_base64)} chars")
    
    mime_type = "audio/m4a" if audio_file.suffix.lower() == ".m4a" else "audio/webm"
    
    req = AnalyzeBase64Request(
        session_id="test-session-001",
        mime_type=mime_type,
        audio_base64=audio_base64,
        user_id="test-user",
        user_name="TestUser",
    )
    
    class MockClient:
        host = "localhost"
    
    class MockRequest:
        client = MockClient()
    
    result = await analyze_base64(req, MockRequest())
    
    output_file = Path("session_report_output.json")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    logger.success(f"✅ Output saved: {output_file.absolute()}")
    logger.info(f"\n{'='*80}\n📊 RESULT\n{'='*80}")
    logger.info(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    import sys
    
    logger.info(f"\n{'='*80}\n🚀 AI Session Analyzer - Test Mode\n{'='*80}")
    logger.info(f"🔑 API Key: {GOOGLE_API_KEY[:20]}...")
    logger.info(f"🤖 Model: {MODEL_ID}")
    
    audio_file = sys.argv[1] if len(sys.argv) > 1 else "voice.m4a"
    logger.info(f"🎯 Target: {audio_file}")
    
    asyncio.run(test_with_audio_file(audio_file))
