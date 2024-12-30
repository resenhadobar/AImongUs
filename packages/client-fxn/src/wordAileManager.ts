import {FxnClient} from "./fxnClient.ts";

interface PlayerRole {
    type: 'crewmate' | 'impostor';
    room: number;  // 0-5 for the 6 rooms
}

interface PlayerAction {
    type: 'accuse' | 'pass' | 'kill';
    target?: string;  // publicKey of target for accuse/kill
    accusationText?: string;  // What they say when accusing
}

interface PlayerMovement {
    type: 'stay' | 'clockwise' | 'counterclockwise';
}

interface PlayerVote {
    target: string | null;  // publicKey of voted player, null for skip
    voteText: string;  // What they say when voting
}

interface PlayerState {
    publicKey: string;
    role: PlayerRole;
    isAlive: boolean;
    lastAction?: PlayerAction;
    lastMovement?: PlayerMovement;
    lastVote?: PlayerVote;
}

interface GameState {
    players: Map<string, PlayerState>;
    phase: 'action' | 'movement' | 'voting' | 'complete';
    currentRound: number;
    actionOrder: string[];  // Array of publicKeys in action order
    accusedPlayer?: string;  // publicKey of player being voted on
    votingResults?: Map<string, string>;  // voter publicKey -> voted publicKey
    isActive: boolean;
    winner?: 'crew' | 'impostors';
}

export class AmongUsManager {
    private gameState: GameState;
    private readonly ROUND_DURATION = 2 * 60 * 1000;  // 2 minutes per round
    private readonly ACTION_DURATION = 30 * 1000;     // 30 seconds for actions
    private readonly MOVEMENT_DURATION = 15 * 1000;   // 15 seconds for movement
    private readonly VOTING_DURATION = 45 * 1000;     // 45 seconds for voting
    private roundTimer: NodeJS.Timeout | null = null;
    private phaseTimer: NodeJS.Timeout | null = null;

    constructor(private fxnClient: FxnClient) {
        this.gameState = this.initializeGameState();
        this.startGame();
    }

    private initializeGameState(): GameState {
        return {
            players: new Map(),
            phase: 'action',
            currentRound: 1,
            actionOrder: [],
            isActive: true
        };
    }

    private assignRoles(players: string[]): void {
        // Shuffle players
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        
        // Assign 2 impostors and rest as crew
        shuffled.forEach((publicKey, index) => {
            const role: PlayerRole = {
                type: index < 2 ? 'impostor' : 'crewmate',
                room: Math.floor(Math.random() * 6) // Random room 0-5
            };

            this.gameState.players.set(publicKey, {
                publicKey,
                role,
                isAlive: true
            });
        });
    }

    private async startGame(): Promise<void> {
        const subscribers = await this.fxnClient.getSubscribers();
        let activePlayers = subscribers
            .filter(sub => sub.status === 'active')
            .map(sub => sub.subscriber.toString());

        // Add bot players if needed
        while (activePlayers.length < 6) {
            activePlayers.push(`bot-${activePlayers.length + 1}`);
        }

        this.assignRoles(activePlayers);
        this.gameState.actionOrder = this.shuffleActionOrder();
        await this.startRound();
    }

    private shuffleActionOrder(): string[] {
        return Array.from(this.gameState.players.keys())
            .filter(key => this.gameState.players.get(key)?.isAlive)
            .sort(() => Math.random() - 0.5);
    }

    private async startRound(): Promise<void> {
        if (!this.gameState.isActive) return;  // Add guard clause
        
        this.gameState.phase = 'action';
        this.gameState.actionOrder = this.shuffleActionOrder();
        
        // Clear previous timers
        if (this.phaseTimer) {
            clearTimeout(this.phaseTimer);
        }
        
        await this.broadcastGameState();
        this.phaseTimer = setTimeout(() => this.startMovementPhase(), this.ACTION_DURATION);
    }


    private async startMovementPhase(): Promise<void> {
        this.gameState.phase = 'movement';
        await this.broadcastGameState();
        
        this.phaseTimer = setTimeout(() => this.processRound(), this.MOVEMENT_DURATION);
    }

    private async startVotingPhase(accusedPlayer: string): Promise<void> {
        this.gameState.phase = 'voting';
        this.gameState.accusedPlayer = accusedPlayer;
        this.gameState.votingResults = new Map();
        await this.broadcastGameState();

        this.phaseTimer = setTimeout(() => this.processVotes(), this.VOTING_DURATION);
    }

    private async processVotes(): Promise<void> {
        if (!this.gameState.votingResults || !this.gameState.accusedPlayer) return;
        
        const votes = new Map<string, number>();
        votes.set('skip', 0);

        // Count votes
        this.gameState.votingResults.forEach((target) => {
            votes.set(target, (votes.get(target) || 0) + 1);
        });

        // Find highest vote count
        let maxVotes = 0;
        let ejected: string | null = null;
        votes.forEach((count, target) => {
            if (count > maxVotes) {
                maxVotes = count;
                ejected = target;
            }
        });

        // Eject player if majority
        if (ejected && ejected !== 'skip') {
            const player = this.gameState.players.get(ejected);
            if (player) player.isAlive = false;
        }

        await this.checkWinCondition();
        if (this.gameState.isActive) {
            await this.startRound();
        }
    }

    private async processRound(): Promise<void> {
        console.log("Processing round...");
        console.log("All player states before processing:", 
            Array.from(this.gameState.players.values())
                .map(p => ({
                    publicKey: p.publicKey,
                    lastAction: p.lastAction,
                    lastMovement: p.lastMovement,
                    role: p.role,
                    isAlive: p.isAlive
                }))
        );
        
        // Clear any existing timers
        if (this.phaseTimer) {
            clearTimeout(this.phaseTimer);
            this.phaseTimer = null;
        }
        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }
        
        // Process kills first
        for (const [publicKey, player] of this.gameState.players.entries()) {
            if (player.lastAction?.type === 'kill' && player.lastAction.target) {
                const target = this.gameState.players.get(player.lastAction.target);
                if (target && target.isAlive && player.role.type === 'impostor') {
                    // Verify same room and impostor status
                    if (target.role.room === player.role.room) {
                        target.isAlive = false;
                        console.log(`Player ${target.publicKey} was killed by ${player.publicKey}`);
                    }
                }
            }
        }
    
        // Update positions based on movements
        for (const [publicKey, player] of this.gameState.players.entries()) {
            if (player.lastMovement?.type === 'clockwise') {
                player.role.room = (player.role.room + 1) % 6;
            } else if (player.lastMovement?.type === 'counterclockwise') {
                player.role.room = (player.role.room + 5) % 6;
            }
        }
    
        // Clear only the action/movement records while preserving states
        for (const [publicKey, player] of this.gameState.players.entries()) {
            player.lastAction = undefined;
            player.lastMovement = undefined;
        }
    
        console.log("All player states after processing:", 
            Array.from(this.gameState.players.values())
                .map(p => ({
                    publicKey: p.publicKey,
                    room: p.role.room,
                    isAlive: p.isAlive,
                    role: p.role
                }))
        );
    
        await this.checkWinCondition();
        console.log("Game state after win condition check:", {
            isActive: this.gameState.isActive,
            winner: this.gameState.winner,
            alivePlayers: Array.from(this.gameState.players.values())
                .filter(p => p.isAlive).length
        });

        if (this.gameState.isActive) {
            this.gameState.currentRound++;
            await this.startRound();
        } else {
            // Broadcast final game state
            await this.broadcastGameState();
        }
    }

    private async broadcastGameState(): Promise<void> {
        const subscribers = await this.fxnClient.getSubscribers();
        console.log('Broadcasting game state to subscribers:', subscribers);
        
        // Handle real players
        const promises = subscribers.map(async subscriber => {
            try {
                const publicKey = subscriber.subscriber.toString();
                const playerView = this.getPlayerView(publicKey);
                
                if (subscriber.status === 'active') {
                    const formattedMessage = {
                        gameState: playerView,
                        type: 'game_update'
                    };
                    
                    console.log(`Broadcasting to ${publicKey}:`, formattedMessage);
                    
                    const response = await this.fxnClient.broadcastToSubscribers(
                        formattedMessage, 
                        [subscriber]
                    );
                    
                    if (response?.[0]?.status === 'fulfilled') {
                        const result = (response[0] as PromiseFulfilledResult<Response>).value;
                        if (result.ok) {
                            const responseData = await result.json();
                            console.log(`Raw response data from ${publicKey}:`, responseData);
                            
                            const player = this.gameState.players.get(publicKey);
                            if (!player || !player.isAlive) return;
                    
                            switch (this.gameState.phase) {
                                case 'action':
                                    if (responseData.type) {
                                        // Validate kill actions
                                        if (responseData.type === 'kill') {
                                            if (player.role.type !== 'impostor') {
                                                responseData.type = 'pass';
                                            }
                                        }
                                        player.lastAction = responseData;
                                        console.log(`Updated action for ${publicKey}:`, player.lastAction);
                                    }
                                    break;
                                case 'movement':
                                    if (responseData.type) {
                                        player.lastMovement = responseData;
                                        console.log(`Updated movement for ${publicKey}:`, player.lastMovement);
                                    }
                                    break;
                                case 'voting':
                                    if (responseData.target !== undefined) {
                                        player.lastVote = responseData;
                                        this.gameState.votingResults?.set(publicKey, responseData.target || 'skip');
                                        console.log(`Updated vote for ${publicKey}:`, player.lastVote);
                                    }
                                    break;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Error communicating with subscriber:`, error);
            }
        });
    
        // Handle bot players
        for (const [publicKey, player] of this.gameState.players.entries()) {
            if (publicKey.startsWith('bot-') && player.isAlive) {
                const playerView = this.getPlayerView(publicKey);
                const botDecision = await this.makeBotDecision(playerView);

                switch (this.gameState.phase) {
                    case 'action':
                        player.lastAction = botDecision;
                        break;
                    case 'movement':
                        player.lastMovement = botDecision;
                        break;
                    case 'voting':
                        player.lastVote = botDecision;
                        this.gameState.votingResults?.set(publicKey, botDecision.target || 'skip');
                        break;
                }
            }
        }

        await Promise.all(promises);
    }

    private async checkWinCondition(): Promise<void> {
        const alivePlayers = Array.from(this.gameState.players.values())
            .filter(p => p.isAlive);
        
        const aliveImpostors = alivePlayers
            .filter(p => p.role.type === 'impostor').length;
        
        const aliveCrew = alivePlayers.length - aliveImpostors;

        console.log("Win condition check:", {
            alivePlayers: alivePlayers.length,
            aliveImpostors,
            aliveCrew
        });

        if (aliveImpostors === 0) {
            this.gameState.isActive = false;
            this.gameState.winner = 'crew';
        } else if (aliveCrew === 0) {
            this.gameState.isActive = false;
            this.gameState.winner = 'impostors';
        }
    }


    private getPlayerView(publicKey: string): any {
        const player = this.gameState.players.get(publicKey);
        const isImpostor = player?.role.type === 'impostor';

        return {
            phase: this.gameState.phase,
            currentRound: this.gameState.currentRound,
            actionOrder: this.gameState.actionOrder,
            accusedPlayer: this.gameState.accusedPlayer,
            yourRole: player?.role,
            players: Array.from(this.gameState.players.values()).map(p => ({
                publicKey: p.publicKey,
                isAlive: p.isAlive,
                room: p.role.room,
                role: isImpostor ? p.role.type : undefined,
                lastAction: p.lastAction,
                lastVote: p.lastVote
            })),
            winner: this.gameState.winner
        };
    }

    private async makeBotDecision(gameState: any): Promise<any> {
        const isImpostor = gameState.yourRole.type === 'impostor';
        const phase = gameState.phase;

        switch (phase) {
            case 'action':
                if (isImpostor && Math.random() < 0.3) { // 30% chance to kill
                    const potentialTargets = gameState.players.filter((p: any) => 
                        p.isAlive && p.room === gameState.yourRole.room && !p.role
                    );
                    if (potentialTargets.length > 0) {
                        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        return { type: 'kill', target: target.publicKey };
                    }
                }
                return { type: 'pass' };

            case 'movement':
                const movements = ['stay', 'clockwise', 'counterclockwise'];
                return { type: movements[Math.floor(Math.random() * movements.length)] };

            case 'voting':
                if (Math.random() < 0.7) { // 70% chance to vote for accused
                    return { target: gameState.accusedPlayer, voteText: 'Suspicious behavior' };
                }
                return { target: null, voteText: 'Not enough evidence' };

            default:
                return { type: 'pass' };
        }
    }
}