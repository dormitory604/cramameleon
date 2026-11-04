import type { AgentEvent, AgentInput, AgentRunner } from '../contracts/index.ts';
// Explicitly imported only by UI development/tests. Production UI never selects this runner.
type Payload<T> = T extends unknown ? Omit<T, 'sessionId' | 'turnId'> : never;
export class FakeAgent implements AgentRunner {
  events: Payload<AgentEvent>[];
  constructor(events: Payload<AgentEvent>[] = []) { this.events = events; }
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    let terminal: Extract<AgentEvent, { type: 'done' }>['status'] = 'completed';
    for (const event of this.events) {
      if (input.signal.aborted) break;
      if (event.type === 'done') { terminal = event.status; break; }
      yield { ...event, sessionId: input.sessionId, turnId: input.turnId } as AgentEvent;
    }
    yield { type: 'done', status: input.signal.aborted ? 'cancelled' : terminal, sessionId: input.sessionId, turnId: input.turnId };
  }
}
