#!/usr/bin/env node
'use strict'

const mqtt = require('mqtt')
const commands = require('./app/commandEnums')
const argv = require('minimist')(process.argv.slice(2), {
  string: ['hvac-host', 'mqtt-broker-url', 'mqtt-topic-prefix', 'mqtt-username', 'mqtt-password'],
  '--': true
})

// console.log("[DEBUG] Using argv:", argv)

/**
 * Debug Flag
 */
const debug = argv['debug'] ? true : false

/**
 * Connect to device
 */
const skipCmdNames = ['temperatureUnit']
const publicValDirect = ['power', 'health', 'powerSave', 'lights', 'quiet', 'blow', 'sleep', 'turbo']
const onStatus = function (deviceModel, changed) {
  // console.log("[DEBUG] onStatus called:", JSON.stringify({"deviceModel.name": deviceModel.name, changed}))
  const publish = (name, val) => {
    // console.log("Publish:",JSON.stringify({name, val}))
    publish2mqtt(val, deviceModel.mac + '/' + name.toLowerCase())
    if (!deviceModel.isSubDev)
      publish2mqtt(val, name.toLowerCase())
  }
  for (let name in changed) {
    if (skipCmdNames.includes(name))
      continue
    let val = changed[name].state
    if (publicValDirect.includes(name))
      val = changed[name].value
    /**
     * Handle "off" mode status
     * Hass.io MQTT climate control doesn't support power commands through GUI,
     * so an additional pseudo mode is added
     */
    if (name === 'mode' && deviceModel.props[commands.power.code] === commands.power.value.off)
      val = 'off'
    if (name === 'power') {
      if (changed[name].state === 'on')
        publish('mode', Object.keys(commands.mode.value).find(k => deviceModel.props[commands.mode.code] === commands.mode.value[k]))
      else if (changed[name].state === 'off')
        publish('mode', 'off')
    }
    publish(name, val)
  }
  publish('firmware', deviceModel.controller.controller.firmware)
  publish('ip', deviceModel.controller.controller.address)
}

const onSetup = function (deviceModel) {
  for (let name of Object.keys(commands)) {
    if (skipCmdNames.includes(name))
      continue
    client.subscribe(mqttTopicPrefix + deviceModel.mac + '/' + name.toLowerCase() + '/set')
    if (!deviceModel.isSubDev)
      client.subscribe(mqttTopicPrefix + name.toLowerCase() + '/set')
  }
  /**
   * Publish all status every 10 mins.
   */
  setTimeout(() => {
    onStatus(deviceModel, deviceModel._prepareCallback(deviceModel.props))
  }, 600 * 1000)
  /**
   * HomeAssistant MQTT Discovery
   */
  if (argv['homeassistant-mqtt-discovery']) {
    const HA_DISCOVERY = require('./discovery/homeassistant').publish({
      debug,
      device_mac: deviceModel.mac,
      device_name: deviceModel.name,
      device_temperatureUnit: Object
        .keys(commands.temperatureUnit.value)
        .find(k => commands.temperatureUnit.value[k] === deviceModel.props[commands.temperatureUnit.code])
        .substring(0, 1)
        .toUpperCase(),
      mqttClient: client,
      mqttDeviceTopic: mqttTopicPrefix + deviceModel.mac,
      mqttPubOptions: pubmqttOptions
    })
    let enabled_commands
    if (argv['homeassistant-mqtt-discovery-enable'])
      enabled_commands = argv['homeassistant-mqtt-discovery-enable'].split(',')
    // HA_DISCOVERY.REGISTER(enabled_commands)
    HA_DISCOVERY.REGISTER_ALL()
  }
}

const deviceOptions = {
  host: argv['hvac-host'],
  controllerOnly: argv['controllerOnly'] ? true : false,
  pollingInterval: parseInt(argv['polling-interval']) * 1000 || 1000,
  debug: debug,
  onStatus: (deviceModel, changed) => {
    if (changed && Object.keys(changed).length) {
      onStatus(deviceModel, changed)
      console.log('[UDP] deviceOptions.onStatus:', JSON.stringify({ ip: deviceModel.address, changed }))
    }
  },
  onUpdate: (deviceModel, changed) => {
    if (changed && Object.keys(changed).length) {
      onStatus(deviceModel, changed)
      console.log('[UDP] deviceOptions.onUpdate:', JSON.stringify({ ip: deviceModel.address, changed }))
    }
  },
  onSetup: onSetup,
  onConnected: (deviceModel) => {
    // console.log('[UDP] deviceOptions.onConnected:', JSON.stringify({ ip: deviceModel.address }))
  }
}

let hvac

/**
 * Connect to MQTT broker
 */
let __mqttTopicPrefix = argv['mqtt-topic-prefix']
if (!__mqttTopicPrefix.endsWith('/'))
  __mqttTopicPrefix += '/'
const mqttTopicPrefix = __mqttTopicPrefix

const pubmqttOptions = {
  retain: false
}
if (argv['mqtt-retain']) {
  pubmqttOptions.retain = (argv['mqtt-retain'] == "true")
}

const publish2mqtt = function (newValue, mqttTopic) {
  client.publish(mqttTopicPrefix + mqttTopic + '/get', newValue.toString(), pubmqttOptions)
}

const mqttOptions = {}
let authLog = ''
if (argv['mqtt-username'] && argv['mqtt-password']) {
  mqttOptions.username = argv['mqtt-username']
  mqttOptions.password = argv['mqtt-password']
  authLog = ' as "' + mqttOptions.username + '"'
}
console.log('[MQTT] Connecting to ' + argv['mqtt-broker-url'] + authLog + '...')
const client = mqtt.connect(argv['mqtt-broker-url'], mqttOptions)

client.on('reconnect', () => {
  console.log('[MQTT] Reconnecting to ' + argv['mqtt-broker-url'] + authLog + '...')
})

client.stream.on('error', e => {
  console.error('[MQTT] Error:', e)
})

client.on('close', () => {
  console.log(`[MQTT] Disconnected`)
})

client.on('connect', () => {
  console.log('[MQTT] Connected to broker')
  hvac = require('./app/deviceFactory').connect(deviceOptions)
})

client.on('message', (topic, message) => {
  console.log('[MQTT] Message "%s" received for %s', message, topic)

  if (topic.startsWith(mqttTopicPrefix)) {
    let t = topic.substring(mqttTopicPrefix.length).split('/')
    if (t.length === 2)
      t.unshift(hvac.controller.mac)
    let device = hvac.controller.devices[t[0]]
    switch (t[1]) {
      case 'temperature':
        device.setTemp(parseInt(message))
        return
      case 'mode':
        let mode = message.toString().toLowerCase();
        if (mode === 'off') {
          device.setPower(commands.power.value.off)
        }
        else {
          if (device.props[commands.power.code] === commands.power.value.off)
            device.setPower(commands.power.value.on)
          device.setMode(commands.mode.value[message])
        }
        return
      case 'fanspeed':
        // console.log( "changing fanspeed to:", String(message))

        let c = [], v = []
        if (message == 'high' || message == 'turbo') {
          c.push(commands.fanSpeed.code)
          v.push(commands.fanSpeed.value[message])

          c.push(commands.turbo.code)
          v.push(1)

          c.push(commands.quiet.code)
          v.push(0)
          // c.push(commands.swingVert.code)
          // v.push(6)
        }
        else if (message == 'low') {
          c.push(commands.fanSpeed.code)
          v.push(commands.fanSpeed.value[message])

          c.push(commands.turbo.code)
          v.push(0)

          c.push(commands.quiet.code)
          v.push(1)
        }
        else {
          c.push(commands.fanSpeed.code)
          v.push(commands.fanSpeed.value[message])

          c.push(commands.turbo.code)
          v.push(0)

          c.push(commands.quiet.code)
          v.push(0) 
        }
        device._sendCommand(c, v)
        // console.log("debug fan:",{c, v})

        // device.setFanSpeed(commands.fanSpeed.value[message])
        return
      case 'swinghor':
        device.setSwingHor(commands.swingHor.value[message])
        return
      case 'swingvert':
        // console.log('set swingvert:')
        device.setSwingVert(commands.swingVert.value[message])
        return
      case 'power':
        // console.log("process power", {message, props: device.props})
          if (parseInt(message) === 1) {
            device.setPower(commands.power.value.on)
            device.setMode(commands.mode.value.cool) // default mode cool if powered off?
          }
          else {
            device.setPower(commands.power.value.off)
          }
        return
      case 'health':
        device.setHealthMode(parseInt(message))
        return
      case 'powersave':
        device.setPowerSave(parseInt(message))
        return
      case 'lights':
        device.setLights(parseInt(message))
        return
      case 'quiet':
        device.setQuietMode(parseInt(message))
        return
      case 'blow':
        device.setBlow(parseInt(message))
        return
      case 'air':
        device.setAir(parseInt(message))
        return
      case 'sleep':
        device.setSleepMode(parseInt(message))
        return
      case 'turbo':
        device.setTurbo(parseInt(message))
        return
      // TODO: Implement dynamic command for scripts, to set multiple parameters at once
    }
  }
  console.log('[MQTT] No handler for topic %s', topic)
})
