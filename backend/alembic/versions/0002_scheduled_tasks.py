"""Persist tasks awaiting the rolling 24-hour planning window."""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("scheduled_tasks", sa.Column("id", sa.String(), nullable=False),
                    sa.Column("payload", sa.JSON(), nullable=False),
                    sa.Column("scenario_id", sa.String(), nullable=False),
                    sa.ForeignKeyConstraint(["scenario_id"], ["scenario_state.id"]),
                    sa.PrimaryKeyConstraint("id", "scenario_id"))


def downgrade():
    op.drop_table("scheduled_tasks")
