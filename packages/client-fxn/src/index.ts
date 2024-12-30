import express from 'express';
import bodyParser from 'body-parser';
import {IAgentRuntime} from '@ai16z/eliza/src/types.ts';
import {AmongUsManager} from "./wordAileManager.ts";
import {FxnClient} from "./fxnClient.ts";
import {verifyMessage} from "./utils/signingUtils.ts";
import {generateText, ModelClass} from "@ai16z/eliza";

export class FxnClientInterface {
    private app: express.Express;
    private gameManager: AmongUsManager;
    private fxnClient: FxnClient;

    constructor(private runtime: IAgentRuntime) {
        this.app = express();
        this.app.use(bodyParser.json());

        const role = this.runtime.getSetting("FXN_ROLE");
        if (role) {
            this.setupGame(role);
        }
    }

    private createActionPrompt(gameState: any): string {
        const isImpostor = gameState.yourRole.type === 'impostor';
        const playersInRoom = gameState.players.filter(
            (p: any) => p.room === gameState.yourRole.room && 
            p.isAlive && 
            p.publicKey !== gameState.players[0].publicKey
        );

        let prompt = `You are playing Among Us as a ${gameState.yourRole.type}.
Current situation:
- You are in room ${gameState.yourRole.room}
- Players in your room: ${playersInRoom.map((p: any) => p.publicKey).join(', ')}
`;

        if (isImpostor) {
            const otherImpostor = gameState.players.find(
                (p: any) => p.role === 'impostor' && p.publicKey !== gameState.players[0].publicKey
            );
            prompt += `- You can kill one of the crewmates in your room
- Other impostor is ${otherImpostor?.publicKey}
`;
        }

        prompt += `
Choose your action:
1. "pass" - Do nothing
2. "accuse [playerKey]" - Accuse someone of being an impostor (include reason)
${isImpostor && playersInRoom.length > 0 ? '3. "kill [playerKey]" - Kill a crewmate in your room' : ''}

Important: You cannot target yourself or other impostors. Must choose another player if killing or accusing.
Respond with only: pass or "{action} {target} | {reason}"`;

        return prompt;
    }

    private createMovementPrompt(gameState: any): string {
        return `You are in room ${gameState.yourRole.room}.
Choose your movement:
1. "stay" - Stay in current room
2. "clockwise" - Move to next room clockwise
3. "counterclockwise" - Move to previous room counterclockwise

Consider:
- Location of suspicious players
- Location of trusted players
- Safety in numbers
- Your role and objectives

Respond with only: stay, clockwise, or counterclockwise`;
    }

    private validateAction(action: string, target: string, gameState: any): boolean {
        // Check for self-targeting
        if (target === gameState.players[0].publicKey) {
            console.log('Invalid: Self-targeting detected');
            return false;
        }

        // For kill actions, prevent targeting other impostors
        if (action === 'kill') {
            const targetPlayer = gameState.players.find((p: any) => p.publicKey === target);
            if (targetPlayer?.role === 'impostor') {
                console.log('Invalid: Attempted to kill another impostor');
                return false;
            }

            // Verify target is in same room and alive
            if (!gameState.players.some((p: any) => 
                p.publicKey === target && 
                p.room === gameState.yourRole.room && 
                p.isAlive
            )) {
                console.log('Invalid: Target not in same room or not alive');
                return false;
            }
        }

        return true;
    }

    private async handleGameState(gameState: any): Promise<any> {
        console.log('Processing game state:', JSON.stringify(gameState, null, 2));
        
        switch (gameState.phase) {
            case 'action': {
                const actionResponse = await generateText({
                    runtime: this.runtime,
                    context: this.createActionPrompt(gameState),
                    modelClass: ModelClass.SMALL
                });
                console.log('Generated action response:', actionResponse);
                
                if (actionResponse.toLowerCase().startsWith('pass')) {
                    return { type: 'pass' };
                }

                const [action, text] = actionResponse.split(' | ');
                const [type, target] = action.split(' ');
                
                if (!this.validateAction(type, target, gameState)) {
                    return { type: 'pass' };
                }

                return { type, target, accusationText: text };
            }

            case 'movement': {
                const movement = await generateText({
                    runtime: this.runtime,
                    context: this.createMovementPrompt(gameState),
                    modelClass: ModelClass.SMALL
                });
                return { type: movement.trim() };
            }

            default:
                console.error('Unknown game phase:', gameState.phase);
                return { type: 'pass' };
        }
    }

    private setupRoutes() {
        console.log('Setting up routes for player');
        const handleRequest = async (req: any, res: any) => {
            try {
                const { publicKey, signature, payload } = req.body;
        
                console.log('Received POST request:', {
                    path: req.path,
                    body: req.body,
                    headers: req.headers
                });
        
                console.log('Game state is:', req.body);
        
                const gameMasterKey = this.runtime.getSetting("GAME_MASTER_KEY");
        
                const verificationResult = await verifyMessage({
                    payload,
                    signature,
                    publicKey: gameMasterKey
                });
        
                if (!verificationResult.isValid) {
                    return res.status(401).json({
                        error: 'Invalid signature',
                        details: 'Message signature verification failed'
                    });
                }
        
                const decision = await this.handleGameState(payload.gameState);
                console.log('Generated decision:', decision);
        
                console.log('Sending response:', decision);
                return res.json(decision);
        
            } catch (error) {
                console.error('Error processing request:', error);
                return res.status(500).json({ type: 'pass' });
            }
        };

        this.app.post('/', handleRequest);
        this.app.post('', handleRequest);
    }

    private setupGame(role: string) {
        if (role === 'PLAYER') {
            this.setupRoutes();
        }
        if (role === 'HOST') {
            this.fxnClient = new FxnClient({ runtime: this.runtime });
            this.setupGameLoop();
            this.setupHostRoutes();
        }
        const port = this.runtime.getSetting("SERVER_PORT") || 3000;
        this.app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    }

    private setupHostRoutes() {
        this.app.get('/api/game-state', (req, res) => {
            // Return game state for front-end
        });
    }

    private setupGameLoop() {
        this.gameManager = new AmongUsManager(this.fxnClient);
    }

    static async start(runtime: IAgentRuntime) {
        return new FxnClientInterface(runtime);
    }

    async stop() {
        console.log('Stopping client');
    }
}