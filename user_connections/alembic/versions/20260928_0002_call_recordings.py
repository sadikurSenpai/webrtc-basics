"""call recordings + admin flag

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

recording_status = sa.Enum("recording", "complete", "partial", "failed", name="recording_status")


def upgrade() -> None:
    op.add_column("users", sa.Column("is_admin", sa.Boolean(), server_default="false", nullable=False))

    op.create_table(
        "call_recordings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("s3_prefix", sa.String(512), nullable=False),
        sa.Column("file_ext", sa.String(8), nullable=False),
        sa.Column("mime_type", sa.String(64), nullable=False),
        sa.Column("status", recording_status, nullable=False),
        sa.Column("chunk_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("call_id", "user_id", name="uq_call_recordings_call_user"),
    )
    op.create_index("ix_call_recordings_call_id", "call_recordings", ["call_id"])


def downgrade() -> None:
    op.drop_table("call_recordings")
    recording_status.drop(op.get_bind(), checkfirst=True)
    op.drop_column("users", "is_admin")
