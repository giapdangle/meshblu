var _ = require('lodash');
var config = require('../config');
var getDevice = require('./getDevice');
var logEvent = require('./logEvent');
var sendYo = require('./sendYo');
var sendSms = require('./sendSms');
var securityImpl = require('./getSecurityImpl');
var sendActivity = require('./sendActivity');
var createActivity = require('./createActivity');
var sendPushNotification = require('./sendPushNotification');
var debug = require('debug')('meshblu:sendMessage');
var doMessageHooks = require('./doMessageHooks');

var DEFAULT_QOS = 0;

function publishActivity(topic, fromDevice, toDevice, data){
  if(fromDevice && fromDevice.ipAddress){
    sendActivity(createActivity(topic, fromDevice.ipAddress, fromDevice, toDevice, data));
  }
}

function cloneMessage(msg, device, fromUuid){
  if(typeof msg === 'object'){
    var clonedMsg = _.clone(msg);
    clonedMsg.devices = device; //strip other devices from message
    delete clonedMsg.protocol;
    delete clonedMsg.api;
    clonedMsg.fromUuid = msg.fromUuid; // add from device object to message for logging
    return clonedMsg;
  }

  return msg;
}


function createMessageSender(socketEmitter, mqttEmitter, parentConnection){

  function forwardMessage(message){
    if(parentConnection && message){
      try{
        message.originUuid = message.fromUuid;
        delete message.fromUuid;
        parentConnection.message(message);
      }catch(ex){
        console.error('error forwarding message', ex);
      }
    }
  }

  function broadcastMessage(data, topic, fromUuid, fromDevice){
    var devices = data.devices;

    if(!isBroadcast(devices, topic)){ return; }

    //broadcasting should never require responses
    delete data.ack;

    var broadcastType = topic === 'tb' ? '_tb' : '_bc';
    socketEmitter(fromUuid + broadcastType, topic, data);
    socketEmitter(fromUuid + '_sent', topic, data);
    publishActivity(topic, fromDevice, null, data);
    var logMsg = _.clone(data);
    logMsg.from = _.pick(_.clone(fromDevice), config.preservedDeviceProperties);
    logEvent(300, logMsg);
  };

  var sendMessage = function(device, data, topic, fromUuid, fromDevice, toDevices){
    if (!device) {
      debug('Device is null');
      return;
    }

    if( isBroadcast([device], topic) ) {
      return;
    }

    var toDeviceProp = device;
    // if (device.length > 35){
    if (device.length > 0){

      var deviceArray = device.split('/');
      if(deviceArray.length > 1){
        device = deviceArray.shift();
        toDeviceProp = deviceArray.join('/');
      }

      debug('Checking for device', device);
      //check devices are valid
      getDevice(device, function(error, check) {
        var clonedMsg = cloneMessage(data, toDeviceProp, fromUuid);
        debug('clonedMsg', clonedMsg);

        if(error){
          debug('error getting device', error);
          clonedMsg.UNAUTHORIZED=true; //for logging
          return forwardMessage(clonedMsg);
        }

        if(topic === 'tb'){
          delete clonedMsg.devices;
        }

        securityImpl.canSend(fromDevice, check, function(error, permission){
          publishActivity(topic, fromDevice, check, data);
          var emitMsg = clonedMsg;

          if(error || !permission){
            debug('not allowed to send to device', fromDevice.uuid, check.uuid);
            clonedMsg.UNAUTHORIZED=true; //for logging
            return forwardMessage(clonedMsg);
          }

          // Added to preserve to devices in message
          emitMsg.devices = toDevices;

          if(check.payloadOnly){
            emitMsg = clonedMsg.payload;
          }

          debug('Sending message', emitMsg);

          var logMsg = _.clone(clonedMsg);
          logMsg.toUuid = check.uuid;
          logMsg.to = _.pick(check, config.preservedDeviceProperties);
          logMsg.from = _.pick(fromDevice, config.preservedDeviceProperties);
          logEvent(300, logMsg);

          if (check.meshblu) {
            doMessageHooks(check.meshblu.messageHooks, emitMsg);
          }

          socketEmitter(check.uuid, topic, emitMsg);
          socketEmitter(fromDevice.uuid + '_sent', topic, emitMsg);
        });
      });
    }
  };

  var isBroadcast = function(devices, topic){
    return _.contains(devices, '*') || _.contains(devices, 'all') || (topic === 'tb' && _.isEmpty(devices));
  };

  return function(fromDevice, data, topic){
    if(!data.devices) {
      return;
    }

    topic = topic || 'message';

    var fromUuid;
    if(fromDevice){
      fromUuid = fromDevice.uuid;
    }

    if(fromUuid){
      data.fromUuid = fromUuid;
    }

    delete data.token;

    broadcastMessage(data, topic, fromUuid, fromDevice);


    var devices = data.devices;
    if( typeof devices === 'string' ) {
      devices = [ devices ];
    }

    //cant ack to multiple devices
    if(devices.length > 1){
      delete data.ack;
    }

    _.each(devices, function(device) {
      sendMessage(device, data, topic, fromUuid, fromDevice, data.devices);
    });
  };
}

module.exports = createMessageSender;
