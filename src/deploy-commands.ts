import { REST, Routes } from "discord.js";
import { slashCommands } from "./commands.js";
import { config } from "./config.js";
const rest=new REST({version:"10"}).setToken(config.token);
if(config.guildId) await rest.put(Routes.applicationGuildCommands(config.clientId,config.guildId),{body:slashCommands});
else await rest.put(Routes.applicationCommands(config.clientId),{body:slashCommands});
console.log(`Deployed ${slashCommands.length} slash commands (${config.guildId?`guild ${config.guildId}`:"global"}).`);
