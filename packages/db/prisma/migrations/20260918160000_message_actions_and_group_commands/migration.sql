-- Five new live-browser actions, added the same way LOGOUT was: an enum value cannot be used in
-- the same transaction that adds it, so this migration contains ONLY the enum change. The command
-- processor's handlers land in application code, not here.
ALTER TYPE "WorkerCommandType" ADD VALUE 'REACT_TO_MESSAGE';
ALTER TYPE "WorkerCommandType" ADD VALUE 'EDIT_MESSAGE';
ALTER TYPE "WorkerCommandType" ADD VALUE 'CREATE_GROUP';
ALTER TYPE "WorkerCommandType" ADD VALUE 'JOIN_GROUP';
ALTER TYPE "WorkerCommandType" ADD VALUE 'UPDATE_PROFILE';
