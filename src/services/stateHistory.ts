import { Types } from 'mongoose';
import { IStateHistoryEntry } from '../models/Order';
import { IWorkflowState } from '../models/WorkflowState';

/**
 * Builds a history entry with the state's display data frozen in. Always go
 * through this instead of pushing to stateHistory by hand, so no write site
 * forgets the snapshot.
 */
export function buildHistoryEntry(
  state: IWorkflowState,
  changedBy?: string | Types.ObjectId
): IStateHistoryEntry {
  return {
    kind: state.kind,
    state: state._id,
    stateName: state.name,
    stateColor: state.color,
    stateIcon: state.icon,
    changedAt: new Date(),
    changedBy: changedBy ? new Types.ObjectId(changedBy) : undefined,
  };
}
