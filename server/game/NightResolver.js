export class NightResolver {

    resolve(game) {

        const killList = game.mafiaKillList();
        const alive = game.activePlayers();

        const randomKill =
            killList[Math.floor(Math.random() * killList.length)] ?? null;

        const randomProtect =
            alive[Math.floor(Math.random() * alive.length)]?.name ?? null;

        const randomInvestigate =
            alive[Math.floor(Math.random() * alive.length)]?.name ?? null;

        let mafiaKilled = null;
        let doctorSaved = randomProtect;
        let detectiveResult = null;

        if (randomKill && randomKill !== randomProtect) {

            const player = game.getPlayer(randomKill);

            if (player) {
                player.alive = false;
                mafiaKilled = player.name;
            }

        }

        if (randomInvestigate) {

            const player = game.getPlayer(randomInvestigate);

            detectiveResult = {
                player: player.name,
                role: player.role
            };

        }

        const winCondition = game.checkWinCondition();

        return {
            mafiaKilled,
            doctorSaved,
            detectiveResult,
            targeted: randomKill,
            winCondition
        };

    }

}