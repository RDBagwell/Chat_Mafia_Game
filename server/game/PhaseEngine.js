import { NightResolver } from "./NightResolver.js";
import { DayResolver } from "./DayResolver.js";
import { EventBuilder } from "./EventBuilder.js";

export class PhaseEngine {

    constructor() {
        this.nightResolver = new NightResolver();
        this.dayResolver = new DayResolver();
        this.eventBuilder = new EventBuilder();
    }

    runNight(game) {

        const result = this.nightResolver.resolve(game);

        const event = this.eventBuilder.buildNightEvent(game, result);

        game.events.push(event);

        game.setPhase("day");
    }

    runDay(game) {

        const result = this.dayResolver.resolve(game);

        const event = this.eventBuilder.buildDayEvent(game, result);

        game.events.push(event);

        game.setPhase("night");
    }

}