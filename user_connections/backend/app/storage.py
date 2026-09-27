"""S3 helpers for call recordings.

Layout: <prefix>/<call_id>/<user_id>/00000.webm, 00001.webm, ...
Each chunk is one 10-second slice from the device's MediaRecorder. Joined in
order, the chunks form one playable file.

Signing a URL is a local computation (no network call), so issuing a batch
of 60 URLs is cheap. Only list_chunks() actually talks to S3.
"""

from functools import lru_cache

import boto3
from botocore.config import Config

from app.config import settings

EXTENSIONS = {"video/webm": ".webm", "audio/webm": ".webm", "video/mp4": ".mp4", "audio/mp4": ".m4a"}


@lru_cache
def s3():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
    )


def extension_for(mime_type: str) -> str:
    return EXTENSIONS.get(mime_type.split(";")[0].strip(), ".bin")


def recording_prefix(call_id, user_id: int) -> str:
    return f"{settings.s3_recordings_prefix.strip('/')}/{call_id}/{user_id}/"


def chunk_key(prefix: str, index: int, ext: str) -> str:
    return f"{prefix}{index:05d}{ext}"


def presigned_put_urls(prefix: str, ext: str, start: int, count: int) -> list[dict]:
    return [
        {
            "index": i,
            "url": s3().generate_presigned_url(
                "put_object",
                Params={"Bucket": settings.s3_bucket, "Key": chunk_key(prefix, i, ext)},
                ExpiresIn=settings.presigned_url_expire_seconds,
            ),
        }
        for i in range(start, start + count)
    ]


def presigned_get_url(key: str) -> str:
    return s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=settings.presigned_url_expire_seconds,
    )


def list_chunks(prefix: str) -> list[dict]:
    """All chunk objects under a recording's prefix, sorted by index."""
    chunks = []
    for page in s3().get_paginator("list_objects_v2").paginate(Bucket=settings.s3_bucket, Prefix=prefix):
        chunks.extend({"key": o["Key"], "size": o["Size"]} for o in page.get("Contents", []))
    return sorted(chunks, key=lambda c: c["key"])
