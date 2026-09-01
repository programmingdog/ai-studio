import json
import sys
from typing import Any, Dict

PROTOCOL_VERSION = "1.0"


def emit(payload: Dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    # The JSONL wire format is always UTF-8, independent of the Windows
    # console code page inherited by the sidecar process.
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


def progress(request_id: str, value: float, stage: str, message: str) -> None:
    emit({
        "version": PROTOCOL_VERSION,
        "id": request_id,
        "type": "progress",
        "progress": value,
        "stage": stage,
        "message": message,
    })


def result(request_id: str, data: Any) -> None:
    emit({
        "version": PROTOCOL_VERSION,
        "id": request_id,
        "type": "result",
        "success": True,
        "data": data,
    })


def error(request_id: str, code: str, message: str, retryable: bool = False) -> None:
    emit({
        "version": PROTOCOL_VERSION,
        "id": request_id,
        "type": "error",
        "error": {"code": code, "message": message, "retryable": retryable},
    })
