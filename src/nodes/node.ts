import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value, NodeState } from "../types";
import { delay } from "../utils";

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const app = express();
  app.use(express.json());

  let state: NodeState = {
    killed: isFaulty,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  let proposals = new Map<number, Value[]>();
  let votes = new Map<number, Value[]>();

  app.get("/status", (req, res) => res.status(state.killed ? 500 : 200).send(state.killed ? 'faulty' : 'live'));

  app.post("/message", async (req, res) => {
    if (state.killed) {
      return res.status(200).json({ message: "Node is faulty" });
    }
  
    const { k, x, messageType } = req.body;
    let container = messageType.includes("proposal") ? proposals : votes;
  
    if (!container.has(k)) container.set(k, []);
    container.get(k)!.push(x);
  
    if (container.get(k)!.length >= (N - F)) {
      await handleDecision(k, container, messageType);
    }
  
    return res.status(200).json({ message: "Message received" });
  });
  
  app.get("/start", async (req, res) => {
    while (!nodesAreReady()) await delay(5);
    if (!state.killed) await initiatePhase(1, "Phase 1 : proposal phase");
    res.status(200).json({message: "Algorithm started"});
  });

  app.get("/stop", (req, res) => {
    state.killed = true;
    res.send("Node has been stopped");
  });

  app.get("/getState", (req, res) => res.status(200).send(state));

  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  async function handleDecision(k: number, container: Map<number, Value[]>, phase: string) {
    let decision = makeDecision(container.get(k)!);
  
    if (phase.includes("proposal")) {
      if (container.get(k)!.length >= N - F) { // Ensure a clear majority
        await initiatePhase(k, "Phase 2 : voting phase", decision);
      }
    } else {
      // Ensure a clear majority and the node is not faulty
      if (!state.killed && container.get(k)!.length >= N - F) {
        state = { ...state, x: decision, decided: !state.killed, k: k + 1 };
        await delay(200); // Simulate async network delay
        await checkAllNodesDecided(k + 1);
      }
    }
  }
  
  
  async function initiatePhase(k: number, phase: string, x: Value = state.x!) {
    // Initiate the phase only if the node is not faulty
    if (!state.killed) {
      for (let i = 0; i < N; i++) {
        await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ k, x, messageType: phase }),
        });
      }
    }
  }

  function makeDecision(values: Value[]): Value {
    let count = { 0: 0, 1: 0 };
    values.forEach(value => count[value as 0 | 1]++);
    return count[0] > count[1] ? 0 : count[1] > count[0] ? 1 : Math.random() > 0.5 ? 0 : 1;
  }

  async function checkAllNodesDecided(k: number) {
    let decidedCount = 0;
    for (let i = 0; i < N; i++) {
      const response = await fetch(`http://localhost:${BASE_NODE_PORT + i}/getState`);
      const data = await response.json();
      // @ts-ignore
      if (!data.killed && data.decided) decidedCount++; // Only count non-faulty nodes
    }
    // Only initiate shutdown if the majority (accounting for fault tolerance) has decided
    if (decidedCount >= N - F) initiateShutdown();
  }
  

  function initiateShutdown() {
    for (let i = 0; i < N; i++) {
      fetch(`http://localhost:${BASE_NODE_PORT + i}/stop`);
    }
  }

  return server;
}
