export type WatchLocation = 'windows' | 'remote-linux';
export type WatchStatus = 'running' | 'ended';

export interface ProcessCandidate {
	pid: number;
	name: string;
	commandLine: string;
	identity: string;
	startedAt: string;
}

export interface WatchedProcess {
	id: string;
	pid: number;
	name: string;
	commandLine: string;
	identity: string;
	startedAt: string;
	watchStartedAt: string;
	location: WatchLocation;
	workspaceKey: string;
	status: WatchStatus;
	eventUri: string;
	cancelUri: string;
	endedAt?: string;
}