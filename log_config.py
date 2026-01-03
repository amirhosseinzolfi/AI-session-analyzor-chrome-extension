"""
Centralized logging configuration for AI Session Analyzer
Provides structured, colorful logging with rotation and retention
"""
import sys
import json
from pathlib import Path
from contextlib import contextmanager
from loguru import logger
from typing import Optional, Any

class LogConfig:
    """Centralized logging configuration"""
    
    LOG_DIR = Path("logs")
    GLOBAL_LOG_FILE = LOG_DIR / "all_sessions.log"
    LEVEL_METHODS = {
        "TRACE": "trace",
        "DEBUG": "debug",
        "INFO": "info",
        "SUCCESS": "success",
        "WARNING": "warning",
        "ERROR": "error",
        "CRITICAL": "critical",
    }
    
    # Log formats
    FILE_FORMAT = (
        "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
        "<level>{message}</level>"
    )
    
    CONSOLE_FORMAT = (
        "<green>{time:HH:mm:ss.SSS}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{function: <20}</cyan> | "
        "<level>{message}</level>"
    )
    
    SESSION_FORMAT = "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {message}"
    
    @classmethod
    def setup(cls, console_level: str = "INFO", file_level: str = "DEBUG"):
        """Initialize logging configuration"""
        cls.LOG_DIR.mkdir(parents=True, exist_ok=True)
        
        # Remove default logger
        logger.remove()
        
        # Add global file logger
        logger.add(
            cls.GLOBAL_LOG_FILE,
            format=cls.FILE_FORMAT,
            level=file_level,
            rotation="10 MB",
            retention="10 days",
            compression="zip",
            enqueue=True,
            backtrace=True,
            diagnose=True
        )
        
        # Add console logger
        logger.add(
            sys.stdout,
            format=cls.CONSOLE_FORMAT,
            level=console_level,
            colorize=True,
            backtrace=True,
            diagnose=True
        )
        
        logger.info("✅ Logging system initialized")
        logger.debug(f"📁 Log directory: {cls.LOG_DIR.absolute()}")
        logger.debug(f"📄 Global log: {cls.GLOBAL_LOG_FILE.absolute()}")
    
    @classmethod
    @contextmanager
    def session_context(cls, session_id: str):
        session_logger = logger.bind(session_id=session_id)
        cls.log_event(session_logger, "session_start", level="INFO")
        try:
            yield session_logger
        finally:
            cls.log_event(session_logger, "session_end", level="INFO")

    @classmethod
    def log_event(cls, log_handle, event: str, level: str = "INFO", **details: Any):
        payload = cls._prepare_payload({**details, "event": event})
        method_name = cls.LEVEL_METHODS.get(level.upper(), "info")
        # Use opt(depth=1) to show the caller's function name in logs instead of 'log_event'
        getattr(log_handle.opt(depth=1), method_name)(payload)

    @classmethod
    def log_ai_prompt(cls, log_handle, messages: list, level: str = "INFO"):
        """Log the full AI prompt including multimodal content safely"""
        cls.log_event(log_handle, "llm_full_prompt", level=level, messages=messages)

    @staticmethod
    def _prepare_payload(details: dict) -> str:
        def serialize(value: Any):
            # Handle Pydantic models and LangChain messages
            if hasattr(value, "model_dump") and callable(value.model_dump):
                value = value.model_dump()
            elif hasattr(value, "dict") and callable(value.dict):
                value = value.dict()
            
            # Fallback for LangChain messages that don't expose dict/model_dump
            if hasattr(value, "content") and not isinstance(value, (dict, list)):
                return {"type": value.__class__.__name__, "content": serialize(value.content)}

            if isinstance(value, dict):
                return {k: serialize(v) for k, v in value.items()}
            if isinstance(value, (list, tuple, set)):
                return [serialize(v) for v in value]
            
            # Smarter truncation: Truncate base64 heavily, but keep text mostly intact
            if isinstance(value, str) and len(value) > 1000:
                # Heuristic: if no spaces in first 100 chars, it's likely base64/encoded data
                if " " not in value[:100]:
                    return f"{value[:100]}...[TRUNCATED DATA {len(value)} chars]...{value[-100:]}"
                # For text (like system instructions), use a larger limit
                if len(value) > 5000:
                    return f"{value[:2000]}...[TRUNCATED LONG TEXT {len(value)} chars]...{value[-500:]}"
                
            if isinstance(value, (str, int, float, bool)) or value is None:
                return value
            return str(value)
        
        safe_data = {k: serialize(v) for k, v in details.items() if v is not None}
        return json.dumps(safe_data, ensure_ascii=False)
