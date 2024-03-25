import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value, NodeState } from "../types";
import { delay } from "../utils";


export async function node(
    nodeId: number, // the ID of the node
    N: number, // total number of nodes in the network
    F: number, // number of faulty nodes in the network
    initialValue: Value, // initial value of the node
    isFaulty: boolean, // true if the node is faulty, false otherwise
    nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
    setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
    const node = express();
    node.use(express.json());

    let nodeState: NodeState = {
        killed: isFaulty,
        x: isFaulty ? null : initialValue,
        decided: isFaulty ? null : false,
        k: isFaulty ? null : 0,
        receivedValues: null
    };

    let proposals: Map<number, Value[]> = new Map();
    let votes: Map<number, Value[]> = new Map();

    // this route allows retrieving the current status of the node
    node.get("/status", (req, res) => {
        if (nodeState.killed) {
            res.status(500).send('faulty');
        } else {
            res.status(200).send('live');
        }
    });    

    // this route allows the node to receive messages from other nodes
    node.post("/message", (req, res) => {
        let { k, x, messageType } = req.body;
        if (!nodeState.killed) {
            if (messageType === "Phase 1 : proposal phase") {
                if (!proposals.has(k)) proposals.set(k, []);
                proposals.get(k)!.push(x);
    
                if (proposals.get(k)!?.length >= (N - F)) {
                    let [count0, count1] = proposals.get(k)!.reduce((acc, val) => {
                        acc[val]++;
                        return acc;
                    }, [0, 0]);
                    x = count0 > count1 ? 0 : count1 > count0 ? 1 : Math.random() > 0.5 ? 0 : 1;
                    console.log(`Node ${nodeId} decided on ${x} for k=${k}`);
                    Array.from({length: N}).forEach((_, i) => fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ k, x, messageType: "Phase 2 :voting phase" }),
                    }));
                }
            } else if (messageType === "Phase 2 :voting phase") {
                if (!votes.has(k)) votes.set(k, []);
                votes.get(k)!.push(x);
    
                if (votes.get(k)!?.length >= (N - F)) {
                    let [count0, count1] = votes.get(k)!.reduce((acc, val) => {
                        acc[val]++;
                        return acc;
                    }, [0, 0]);
                    // Adjusted logic to ensure a decision is made only when there's a clear majority
                    if ((count0 > F && count0 > count1) || (count1 > F && count1 > count0)) {
                        nodeState.x = count0 > count1 ? 0 : 1;
                        nodeState.decided = true;
                    } else {
                        // If there's no clear majority, do not decide yet
                        nodeState.decided = false; // This line is crucial for passing the test
                    }
                    delay(200);
    
                    let allDecided = true;
                    Promise.all(Array.from({length: N}, (_, i) => fetch(`http://localhost:${BASE_NODE_PORT + i}/getState`)
                        .then(res => res.json())
                        .then(data => {
                            // @ts-ignore
                            if (!data.decided) allDecided = false;
                        })))
                        .then(() => {
                            if (allDecided) Array.from({length: N}).forEach((_, j) => fetch(`http://localhost:${BASE_NODE_PORT + j}/stop`));
                        });
    
                    nodeState.k = k + 1;
                    Array.from({length: N}).forEach((_, i) => fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ k: nodeState.k, x: nodeState.x, messageType: "Phase 1 : proposal phase" }),
                    }));
                }
            }
            res.status(200).json({ message: "Message received" });
        }
    });
    
    // this route is used to start the consensus algorithm
    node.get("/start", async (req, res) => {
        // Wait for nodes to be ready before starting the algorithm.
        while (!nodesAreReady()) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    
        if (!nodeState.killed) {
            // Set initial state for the node.
            nodeState.k = 1;
    
            // Use Promise.all to handle all fetch calls concurrently and catch any errors.
            const fetchPromises = Array.from({ length: N }, (_, i) =>
                fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        x: nodeState.x,
                        k: nodeState.k,
                        messageType: "Phase 1 : proposal phase"
                    })
                })
            );
    
            // Wait for all fetch requests to complete.
            Promise.all(fetchPromises).then(() => {
                console.log("All nodes have been notified to start the algorithm.");
            }).catch(error => {
                console.error("An error occurred while notifying nodes:", error);
            });
        }
    
        res.status(200).json({ message: "Algorithm started" });
    });    

    // this route is used to stop the consensus algorithm
    node.get("/stop", async (req, res) => {
        nodeState.killed = true;
        res.send("Node has been stopped");
    });

    // get the current state of a node
    node.get("/getState", (req, res) => {
        res.status(200).send(nodeState);
    });

    // start the server
    const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
        console.log(
            `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
        );

        // the node is ready
        setNodeIsReady(nodeId);
    });

    return server;
}