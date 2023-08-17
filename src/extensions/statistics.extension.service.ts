import { Injectable } from '@nestjs/common';
import { format } from 'date-fns';
import { Chart as ChartJS, ChartConfiguration, ChartComponentLike } from 'chart.js';
import { ChartJSNodeCanvas, ChartCallback } from 'chartjs-node-canvas'
import erc721abi from '../abi/erc721.json'
import { HttpService } from '@nestjs/axios';
import { BaseService } from '../base.service';
import { ethers } from 'ethers';
import { config } from '../config';
import { Erc721SalesService } from 'src/erc721sales.service';
import Database from 'better-sqlite3'
import rl from 'readline-sync'
import { SlashCommandBuilder } from '@discordjs/builders';
import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v9'

@Injectable()
export class StatisticsService extends BaseService {
  
  provider = this.getWeb3Provider();
  db = new Database(`${process.env.WORK_DIRECTORY || './'}db.db` /*, { verbose: console.log } */);  
  insert: any;
  positionCheck: any;
  positionUpdate: any;

  constructor(
    protected readonly http: HttpService,
    protected readonly erc721service: Erc721SalesService,
  ) {
    super(http)
    console.log('creating StatisticsService')
    this.discordClient.init()
    
    if (!global.doNotStartAutomatically)
      this.start()
    this.registerCommands()
  }

  async registerCommands() {
    //https://discord.com/api/oauth2/authorize?client_id=1139547496033558561&permissions=2048&scope=bot%20applications.commands

    // await delay(10000)

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    
    const userStats = new SlashCommandBuilder()
      .setName('wallet')
      .setDescription('Get statistics about a wallet')
      .addStringOption(option =>
        option.setName('wallet')
          .setDescription('Wallet address or ENS name (leave empty to ignore this filter)')
          .setRequired(true));
    
    const ownedTokens = new SlashCommandBuilder()
      .setName('owned')
      .setDescription('Get owned tokens from a wallet')
      .addStringOption(option =>
        option.setName('wallet')
          .setDescription('Wallet address or ENS name')
          .setRequired(true));

    const volumeStats = new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Get volume statistics')
      .addStringOption(option =>
        option.setName('window')
          .setDescription('Time window')
          .setChoices({
            name: '24 hours',
            value: '24h'
          }, {
            name: '7 days',
            value: '7d'
          }, {
            name: '1 month',
            value: '1m'
          }, {
            name: '1 year',
            value: '1y'
          }, {
            name: 'All times',
            value: 'overall'
          })
          .setRequired(true));

    const graphStats = new SlashCommandBuilder()
      .setName('graph')
      .setDescription('Generate graph')
      .addStringOption(option =>
        option.setName('wallet')
          .setDescription('Restrict to the given wallet')
      )

    const guildIds = config.discord_guild_ids.split(',')
    guildIds.forEach(async (guildId) => {
      await rest.put(
        Routes.applicationGuildCommands(config.discord_client_id, guildId),
        { body: [userStats.toJSON(), volumeStats.toJSON(), graphStats.toJSON(), ownedTokens.toJSON()] },
      );    
    })

    this.discordClient.client.on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isCommand()) return;
        if ('owned' === interaction.commandName) {
          await interaction.deferReply()
          const wallet = interaction.options.get('wallet').value.toString()
          let lookupWallet = wallet
          if (!lookupWallet.startsWith('0x')) {
            // try to find the matching wallet
            const address = await this.provider.resolveName(`${wallet}`);
            if (address) lookupWallet = address
          }
          let ensisedWallet = wallet
          if (wallet.startsWith('0x')) {
            // try to lookup a matching ENS name
            const ens = await this.provider.lookupAddress(`${wallet}`);
            if (ens) ensisedWallet = ens
          }

          const tokens = await this.getOwnedTokens(lookupWallet)
          //const tokensUrl = tokens.map((token) => config.discord_owned_tokens_image_path.replace(new RegExp('<tokenId>', 'g'), `${token.token_id}`.padStart(4, '0')))
          const tokensIds = tokens.map((token) => `#${token.token_id}`)
          const lastEvent = await this.lastEvent()
          let template = config.ownedTokensMessageDiscord
          template = template.replace(new RegExp('<wallet>', 'g'), ensisedWallet);
          template = template.replace(new RegExp('<tokens>', 'g'), tokensIds.join(', '));
          template = template.replace(new RegExp('<last_event>', 'g'), lastEvent.last_event);

          await interaction.editReply(template);

        } else if ('graph' === interaction.commandName) {
          await interaction.deferReply()
          const wallet = interaction.options.get('wallet')?.value.toString()
          let lookupWallet = wallet
          if (lookupWallet && !lookupWallet.startsWith('0x')) {
            // try to find the matching wallet
            const address = await this.provider.resolveName(`${wallet}`);
            if (address) lookupWallet = address
          }
          let ensisedWallet = wallet          
          const lastEvent = await this.lastEvent()
          let template = config.graphStatisticsMessageDiscord
          template = template.replace(new RegExp('<last_event>', 'g'), lastEvent.last_event);
          template = template.replace(new RegExp('<wallet>', 'g'), ensisedWallet ?? 'all');

          const buffer = await this.generateChart(lookupWallet)
          await interaction.editReply({
            content: template,
            files: [buffer]
          });
        } else if ('wallet' === interaction.commandName) {          
          await interaction.deferReply()
          const wallet = interaction.options.get('wallet').value.toString()
          let lookupWallet = wallet
          if (!lookupWallet.startsWith('0x')) {
            // try to find the matching wallet
            const address = await this.provider.resolveName(`${wallet}`);
            if (address) lookupWallet = address
          }
          const stats = await this.userStatistics(lookupWallet)
          let ensisedWallet = wallet
          if (wallet.startsWith('0x')) {
            // try to lookup a matching ENS name
            const ens = await this.provider.lookupAddress(`${wallet}`);
            if (ens) ensisedWallet = ens
          }

          let template = config.userStatisticsMessageDiscord
          template = template.replace(new RegExp('<last_event>', 'g'), stats.last_event);
          template = template.replace(new RegExp('<wallet>', 'g'), ensisedWallet);
          template = template.replace(new RegExp('<tx_count>', 'g'), stats.transactions);
          template = template.replace(new RegExp('<volume>', 'g'), `${Math.round(stats.volume*100)/100}`);
          template = template.replace(new RegExp('<holder_since>', 'g'), stats.holder_since_days);
          template = template.replace(new RegExp('<owned_tokens>', 'g'), stats.owned_tokens);

          await interaction.editReply(template);
        } else if ('volume' === interaction.commandName) {
          await interaction.deferReply()
          const window = interaction.options.get('window').value.toString()
          const stats = await this.globalStatistics(window)
          const lastEvent = await this.lastEvent()
          const totalVolume = `${Math.round(stats.reduce((previous, current) => previous + current.volume, 0)*100)/100}`
          let template = config.globalStatisticsMessageDiscord
          template = template.replace(new RegExp('<last_event>', 'g'), lastEvent.last_event);
          template = template.replace(new RegExp('<window>', 'g'), interaction.options.get('window').value.toString());
          template = template.replace(new RegExp('<nll_volume>', 'g'), this.getPlatformStats('notlarvalabs', stats));
          template = template.replace(new RegExp('<lr_volume>', 'g'), this.getPlatformStats('looksrare', stats));
          template = template.replace(new RegExp('<nftx_volume>', 'g'), this.getPlatformStats('nftx', stats));
          template = template.replace(new RegExp('<os_volume>', 'g'), this.getPlatformStats('opensea', stats));
          template = template.replace(new RegExp('<blurio_volume>', 'g'), this.getPlatformStats('blurio', stats));
          template = template.replace(new RegExp('<x2y2_volume>', 'g'), this.getPlatformStats('x2y2', stats));
          template = template.replace(new RegExp('<cargo_volume>', 'g'), this.getPlatformStats('cargo', stats));
          template = template.replace(new RegExp('<rarible_volume>', 'g'), this.getPlatformStats('rarible', stats));
          template = template.replace(new RegExp('<unknown_volume>', 'g'), this.getPlatformStats('unknown', stats));
          template = template.replace(new RegExp('<total_volume>', 'g'), totalVolume);

          await interaction.editReply(template);          
        }
      } catch (err) {
        console.log(err)
      }
    });      
  }

getOwnedTokens(wallet:string) {
  const sql = `select distinct token_id from 
    (select distinct token_id,
    last_value(to_wallet) over ( 
    partition by token_id order by tx_date 
    RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING ) owner
    from events) a
  where lower(a.owner) = lower(@wallet)`
  const result = this.db.prepare(sql).all({wallet})
  return result
}

  getPlatformStats(platform:string, stats:any[]) {
    const r = stats.filter(s => s.platform === platform)
    return r.length ? ''+Math.ceil(r[0].volume*100)/100 : '0'
  }

  async lastEvent() {
    const sql = `select tx_date last_event from events order by tx_date desc limit 1`
    const row = this.db.prepare(sql).get()
    return row
  }

  async globalStatistics(window:string) {
    const option = window === '24h' ? `DATE('now', '-1 days')` :
      window === '7d' ? `DATE('now', '-7 days')` : 
      window === '1m' ? `DATE('now', '-1 month')` : 
      window === '1y' ? `DATE('now', '-1 year')` : 
      `DATE('now', '-100 year')`
    const sql = `select platform, sum(amount) volume
      from events 
      where tx_date > ${option}
      group by platform`
    const result = this.db.prepare(sql).all()
    return result
  }

  async volumeChartData(wallet:string) {
    let sql = `select 
      date(tx_date) date, 
      sum(amount) volume, 
      avg(amount) average_price, 
      count(*) sales
      from events ev
      where platform <> 'looksrare' 
      <additional_where>
      group by date(tx_date)
      order by date(tx_date)`   
    sql = sql.replace(new RegExp('<additional_where>', 'g'), wallet ? 'AND (lower(from_wallet) = lower(@wallet) OR lower(to_wallet) = lower(@wallet))' : '');
    const params = wallet ? {wallet} : {}
    const result = this.db.prepare(sql).all(params)
    return result
  }

  async userStatistics(wallet:string) {
    const sql = `select 
      count(*) as transactions,
      (select tx_date from events order by tx_date desc limit 1) last_event,
      sum(amount) as volume,
      ceil(JULIANDAY(date()) - min(JULIANDAY(tx_date))) holder_since_days,
      (select count(*) from 
        (select distinct token_id,
        last_value(to_wallet) over ( 
        partition by token_id order by tx_date 
        RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING ) owner
        from events) a
      where a.owner = @wallet) owned_tokens
      from events 
      where lower(to_wallet) = lower(@wallet) 
      or lower(from_wallet) = lower(@wallet) 
      order by tx_date desc
    `
    const row = this.db.prepare(sql).get({wallet})
    return row
  }

  prepareStatements() {
    this.insert = this.db.prepare(`INSERT INTO events (event_type, 
      from_wallet, to_wallet, 
      token_id, amount, tx_date, tx, 
      log_index, platform) 
      VALUES 
      (@eventType, @initialFrom, @initialTo, 
      @tokenId, @alternateValue, @transactionDate, @transactionHash, 
      @logIndex, @platform)
      ON CONFLICT(tx, log_index) DO UPDATE SET amount = excluded.amount, platform=excluded.platform`);
    this.positionUpdate = this.db.prepare(`INSERT INTO configuration 
      VALUES ('currentBlock', @currentBlock)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    this.positionCheck = this.db.prepare(`SELECT * FROM configuration WHERE key = 'currentBlock'`)
    
  }

  async start() {

    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS events (
        event_type text, from_wallet text, to_wallet text, 
        token_id number, amount number, tx_date text, tx text, 
        log_index number, platform text,
        UNIQUE(tx, log_index)
      );`,
    ).run();
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS configuration (
        key text, value text,
        PRIMARY KEY (key)
      );`,
    ).run();
    
    this.prepareStatements();

    const position = this.positionCheck.get()
    if (!position)
      this.positionUpdate.run({currentBlock: config.statistic_initial_block});

    /*
    console.log('create indexes');
    db.run('CREATE INDEX idx_type_date ON events(event_type, tx_date);');
    db.run('CREATE INDEX idx_type_platform_date ON events(event_type, platform, tx_date);');
    db.run('CREATE INDEX idx_date ON events(tx_date);');
    db.run('CREATE INDEX idx_amount ON events(amount);');
    db.run('CREATE INDEX idx_platform ON events(platform);');
    db.run('CREATE INDEX idx_tx ON events(tx);');
    */

    // Listen for Bid event
    const tokenContract = new ethers.Contract(config.contract_address, erc721abi, this.provider);
    let filter = tokenContract.filters.Transfer();

    const result = this.db.prepare(
      `SELECT * FROM configuration WHERE key = 'currentBlock'`,
    ).get();

    let currentBlock:number
    if (result && result.value) currentBlock = result.value
    else {
      currentBlock = await rl.question('Enter the block to start with:\n')
    }
    currentBlock = parseInt(currentBlock+'')

    const chunkSize = 100
    
    while (true) {
      try {
        // check the latest available block
        const latestAvailableBlock = await this.provider.getBlockNumber()
        if (currentBlock > latestAvailableBlock - 1) {
          console.log(`latest block reached (${latestAvailableBlock}), waiting the next available block...`)
          await delay(20000)
          continue
        }
        console.log('querying ' + currentBlock)
        await tokenContract.queryFilter(filter, 
          currentBlock, 
          currentBlock+chunkSize).then(async (events:any) => {
            await this.handleEvents(events)
            this.positionUpdate.run({currentBlock});
            currentBlock += chunkSize
            console.log('moving to next block')    
          });
      } catch (err) {
        console.log('probably 429 spotted — delaying next call', err)
        await delay(5000)
      }
    }    
  }

  async handleEvents(events:any) {
    let i = 0
    while (i < events.length) {
      const elements = events.splice(0, 10)
      await delay(500)
      const results = await Promise.all(elements
        .filter(e => e !== undefined)
        .map(async (e) => this.erc721service.getTransactionDetails(e, true, false)))
      for (let result of results) {
        if (!result) continue
        if (!result.alternateValue && result.ether)
          result.alternateValue = result.ether
        this.insert.run(result);
      }  
      i += 10
    }
  }

  async generateChart(wallet:string) {
    let datas = await this.volumeChartData(wallet)
    const dataMap = new Map();
    datas.forEach(d => dataMap.set(d.date, d))
    const dates = getDates(datas[0].date, datas[datas.length-1].date)
    datas = dates.map(d => {
      return {
        date: d,
        volume: dataMap.get(d)?.volume ?? 0,
        average_price: dataMap.get(d)?.average_price ?? 0
      }
    })
    const MAX_BARS = 250
    if (datas.length > MAX_BARS) {
      const packSize = Math.floor(datas.length/MAX_BARS)
      let count = 0
      let current = {
        volume: 0,
        average_price: 0,
      }
      datas = datas.reduce((previous, next) => {
        count++
        current['volume'] += next.volume
        current['average_price'] += next.average_price
        if (count > packSize) {
          current['date'] = next.date
          count = 0
          current = {
            volume: 0,
            average_price: 0,
          }
          previous.push(current)
        }
        return previous        
      }, [])
    }
    const width = 1200;
    const height = 600;
    const datasets:any[] = [
    {
      label: 'Volume (Ξ)',
      data: datas.map(d => d.volume),
      backgroundColor: [
        '#6A8493',
      ],
      borderColor: [
        '#6A8493',
      ],
      borderWidth: 1,
      yAxisID: 'y1',
    }]
    if (!wallet) {
      datasets.push({
        type: 'line',
        label: 'Average price (Ξ)',
        data: datas.map(d => d.average_price),
        backgroundColor: [
          '#EB37B0'
        ],
        borderColor: [
          '#EB37B0'
        ],
        borderWidth: 1,
        yAxisID: 'y',
      })      
    }
    const configuration:ChartConfiguration = {
      type: 'bar',
      data: {
        labels: datas.map(d => d.date),
        datasets
      },
      options: {
        elements: {
          point: {
              radius: 0
          }
        },
        scales: {
          y: {
              type: 'linear',
              display: true,
              position: 'left',
              grid: {
                color: (ctx) => (ctx.tick.value === 0 ? '#6A8493' : 'transparent'),
                drawTicks: false,
              }
          },
          y1: {
              type: 'linear',
              display: true,
              position: 'right',
              grid: {
                  drawOnChartArea: false,
              },
          },
        } 
      },
      plugins: [{
        id: 'background-colour',
        beforeDraw: (chart) => {
          const ctx = chart.ctx;
          ctx.save();
          ctx.fillStyle = '#1D1E1F';
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        }
      }]
    };
    const chartCallback: ChartCallback = (ChartJS) => {
      ChartJS.defaults.responsive = true;
      ChartJS.defaults.maintainAspectRatio = false;
    };
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback });
    const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    return buffer
  }

}

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}
function addDays(dateIn, days) {
  var date = new Date(dateIn);
  date.setDate(date.getDate() + days);
  return date;
}

function getDates(startDate, stopDate) {
  var dateArray = [];
  var currentDate = startDate;
  while (currentDate <= stopDate) {
      dateArray.push(format(new Date (currentDate), 'yyyy-MM-dd'));
      currentDate = format(addDays(currentDate, 1), 'yyyy-MM-dd');
  }
  return dateArray;
}