"""Create the Rescue+ scenario and plan tables."""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('input_snapshots',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('scenario_state',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('current', sa.Boolean(), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('now', sa.Integer(), nullable=False),
    sa.Column('start_at', sa.String(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('only_current_scenario', 'scenario_state', ['current'], unique=True, sqlite_where=sa.text('current = 1'))
    op.create_table('audit_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('action', sa.String(), nullable=False),
    sa.Column('actor', sa.String(), nullable=False),
    sa.Column('created_at', sa.String(), nullable=False),
    sa.Column('details', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_audit_log_scenario_id'), 'audit_log', ['scenario_id'], unique=False)
    op.create_table('facilities',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id', 'scenario_id')
    )
    op.create_table('incidents',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_incidents_scenario_id'), 'incidents', ['scenario_id'], unique=False)
    op.create_table('plans',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(), nullable=False),
    sa.Column('snapshot_id', sa.String(), nullable=False),
    sa.Column('created_at', sa.String(), nullable=False),
    sa.Column('result', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.ForeignKeyConstraint(['snapshot_id'], ['input_snapshots.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('scenario_id', 'version')
    )
    op.create_index(op.f('ix_plans_scenario_id'), 'plans', ['scenario_id'], unique=False)
    op.create_index('one_active_plan', 'plans', ['scenario_id'], unique=True, sqlite_where=sa.text("status = 'ACTIVE'"))
    op.create_table('tasks',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id', 'scenario_id')
    )
    op.create_table('vehicles',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id', 'scenario_id')
    )
    op.create_table('assignments',
    sa.Column('plan_id', sa.String(), nullable=False),
    sa.Column('task_id', sa.String(), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.ForeignKeyConstraint(['plan_id'], ['plans.id'], ),
    sa.PrimaryKeyConstraint('plan_id', 'task_id')
    )
    op.create_table('recommendations',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('base_plan_id', sa.String(), nullable=False),
    sa.Column('proposed_plan_id', sa.String(), nullable=False),
    sa.Column('base_revision', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(), nullable=False),
    sa.Column('scenario_id', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['base_plan_id'], ['plans.id'], ),
    sa.ForeignKeyConstraint(['proposed_plan_id'], ['plans.id'], ),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario_state.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('proposed_plan_id')
    )
    op.create_index(op.f('ix_recommendations_scenario_id'), 'recommendations', ['scenario_id'], unique=False)
    op.create_table('decisions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('recommendation_id', sa.String(), nullable=False),
    sa.Column('action', sa.String(), nullable=False),
    sa.Column('reason', sa.String(), nullable=False),
    sa.Column('actor', sa.String(), nullable=False),
    sa.Column('created_at', sa.String(), nullable=False),
    sa.ForeignKeyConstraint(['recommendation_id'], ['recommendations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('recommendation_id')
    )


def downgrade():
    op.drop_table('decisions')
    op.drop_index(op.f('ix_recommendations_scenario_id'), table_name='recommendations')
    op.drop_table('recommendations')
    op.drop_table('assignments')
    op.drop_table('vehicles')
    op.drop_table('tasks')
    op.drop_index('one_active_plan', table_name='plans', sqlite_where=sa.text("status = 'ACTIVE'"))
    op.drop_index(op.f('ix_plans_scenario_id'), table_name='plans')
    op.drop_table('plans')
    op.drop_index(op.f('ix_incidents_scenario_id'), table_name='incidents')
    op.drop_table('incidents')
    op.drop_table('facilities')
    op.drop_index(op.f('ix_audit_log_scenario_id'), table_name='audit_log')
    op.drop_table('audit_log')
    op.drop_index('only_current_scenario', table_name='scenario_state', sqlite_where=sa.text('current = 1'))
    op.drop_table('scenario_state')
    op.drop_table('input_snapshots')
