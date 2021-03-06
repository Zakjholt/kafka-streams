"use strict";

const EventEmitter = require("events");
const most = require("most");
const Promise = require("bluebird");
const uuid = require("uuid");

const KStorage = require("./KStorage.js");
const KafkaClient =  require("./KafkaClient.js");
const {KeyCount, Sum, Max, Min} = require("./actions");

const NOOP = () => {};
const MESSAGE = "message";

const PRODUCE_TYPES = {
    SEND: "send",
    BUFFER: "buffer",
    BUFFER_FORMAT: "buffer_format"
};

const DEFAULT_AUTO_FLUSH_BUFFER_SIZE = 100;

/**
 * stream base class
 */
class StreamDSL {

    /**
     * Stream base class that wraps around a private most.js stream$
     * and interacts with storages/actions and a kafka-client instance.
     * @param {string} topicName
     * @param {KStorage} storage
     * @param {KafkaClient} kafka
     * @param {boolean} isClone
     */
    constructor(topicName, storage = null, kafka = null, isClone = false) {

        if(!isClone && (!kafka || !(kafka instanceof KafkaClient))){
            throw new Error("kafka has to be an instance of KafkaClient.");
        }

        if(!storage || !(storage instanceof KStorage)){
            throw new Error("storage hsa to be an instance of KStorage.");
        }

        this.topicName = topicName || ""; //empty topic name is allowed for produce only streams

        this.kafka = kafka;
        this.storage = storage;
        this.isClone = isClone;

        if(!(this.storage instanceof KStorage)){
            throw new Error("storage must be an instance of KStorage.");
        }

        this._ee = new EventEmitter();
        this.stream$ = most.fromEvent(MESSAGE, this._ee);

        this.produceAsTopic = false;
        this.outputTopicName = null;
        this.outputPartitionsCount = 1;
        this.produceType = PRODUCE_TYPES.SEND;
        this.produceVersion = 1;
        this.produceCompressionType = 0;

        this._kafkaStreams = null;

        this.PRODUCE_TYPES = PRODUCE_TYPES;
        this.DEFAULT_AUTO_FLUSH_BUFFER_SIZE = DEFAULT_AUTO_FLUSH_BUFFER_SIZE;
    }

    /**
     * returns a stats object with information
     * about the internal kafka clients
     * @returns {object}
     */
    getStats(){
        return this.kafka ? this.kafka.getStats() : null
    }

    /**
     * returns the internal KStorage instance
     * @returns {KStorage}
     */
    getStorage() {
        return this.storage;
    }

    /**
     * can be used to manually write message/events
     * to the internal stream$
     * @param message
     */
    writeToStream(message){
        this._ee.emit("message", message);
    }

    /**
     * returns the internal most.js stream
     * @returns {Object} most.js stream
     */
    getMost(){
        return this.stream$;
    }

    /**
     * used to clone or during merges
     * resets the internal event emitter to the new stream
     * and replaces the internal stream with the merged new stream
     * @param newStream$
     */
    replaceInternalObservable(newStream$){
        this._ee.removeAllListeners(MESSAGE);
        this._ee = new EventEmitter();
        this.stream$ = most.merge(newStream$, most.fromEvent(MESSAGE, this._ee));
    }

    setKafkaStreamsReference(reference){
        this._kafkaStreams = reference;
    }

    /*
     *   #           #
     *  ##           ##
     * ###    DSL    ###
     *  ##           ##
     *   #           #
     */

    /**
     * simple synchronous map function
     * etl = v -> v2
     * @param etl
     * @returns {StreamDSL}
     */
    map(etl){
        this.stream$ = this.stream$.map(etl);
        return this;
    }

    /**
     * map that expects etl to return a Promise
     * can be used to apply async maps to stream
     * etl = v -> Promise
     * @param etl
     * @returns {StreamDSL}
     */
    asyncMap(etl){
        this.stream$ = this.stream$.flatMap(value => most.fromPromise(etl(value)));
        return this;
    }

    /**
     * (do not use for side effects,
     * except for a closing operation at the end of the stream)
     * may not be used to chain
     * eff = v -> void
     * @param eff
     * @returns Promise{*}
     */
    forEach(eff){
        return this.stream$.forEach(eff);
    }

  /**
   * runs forEach on a multicast stream
   * you probably would not want to use this in production
   * @param eff
   * @param callback
   * @returns {StreamDSL}
   */
    chainForEach(eff, callback = null){
        this.stream$ = this.stream$.multicast();
        this.stream$.forEach(eff).then(r => {
            if(callback){
                callback(null, r);
            }
        }, e => {
            if(callback){
                callback(e);
            }
        });
        return this;
    }

    /**
     * (alternative to forEach if in the middle of a
     * stream operation chain)
     * use this for side-effects
     * errors in eff will break stream
     * @param eff
     */
    tap(eff){
        this.stream$ = this.stream$.tap(eff);
        return this;
    }

    /**
     * stream contains only events for which predicate
     * returns true
     * pred = v -> boolean
     * @param pred
     * @returns {StreamDSL}
     */
    filter(pred){
        this.stream$ = this.stream$.filter(pred);
        return this;
    }

    /**
     * will remove duplicate messages
     * be aware that this might take a lot of memory
     * @returns {StreamDSL}
     */
    skipRepeats(){
        this.stream$ = this.stream$.skipRepeats();
        return this;
    }

    /**
     * skips repeats per your definition
     * equals = (a,b) -> boolean
     * @param equals
     * @returns {StreamDSL}
     */
    skipRepeatsWith(equals){
        this.stream$ = this.stream$.skipRepeatsWith(equals);
        return this;
    }

    /**
     * skips the amount of messages
     * @param count
     * @returns {StreamDSL}
     */
    skip(count){
        this.stream$ = this.stream$.skip(count);
        return this;
    }

    /**
     * takes the first messages until count
     * and omits the rest
     * @param count
     * @returns {StreamDSL}
     */
    take(count){
        this.stream$ = this.stream$.take(count);
        return this;
    }

    multicast(){
        this.stream$ = this.stream$.multicast();
        return this;
    }

    /**
     * easy string to array mapping
     * you can pass your delimiter
     * default is space
     * "bla blup" => ["bla", "blup"]
     * @param delimiter
     * @returns {StreamDSL}
     */
    mapStringToArray(delimiter = " "){

        return this.map(element => {

            if(!element || typeof element !== "string"){
                return element;
            }

            return element.split(delimiter);
        });
    }

    /**
     * easy array to key-value object mapping
     * you can pass your own indices
     * default is 0,1
     * ["bla", "blup"] => { key: "bla", value: "blup" }
     * @param keyIndex
     * @param valueIndex
     * @returns {StreamDSL}
     */
    mapArrayToKV(keyIndex = 0, valueIndex = 1){

        return this.map(element => {

            if(!Array.isArray(element)){
                return element;
            }

            return {
                key: element[keyIndex],
                value: element[valueIndex]
            }
        });
    }

    /**
     * easy string to key-value object mapping
     * you can pass your own delimiter and indices
     * default is " " and 0,1
     * "bla blup" => { key: "bla", value: "blup" }
     * @param delimiter
     * @param keyIndex
     * @param valueIndex
     * @returns {StreamDSL}
     */
    mapStringToKV(delimiter = " ", keyIndex = 0, valueIndex = 1){
        this.mapStringToArray(delimiter);
        this.mapArrayToKV(keyIndex, valueIndex);
        return this;
    }

    /**
     * maps every stream event through JSON.parse
     * if its type is an object
     * (if parsing fails, the error object will be returned)
     * @returns {StreamDSL}
     */
    mapParse(){

        return this.map(string => {

            if(typeof string !== "string"){
                return string;
            }

            try {
                return JSON.parse(string);
            } catch(e){
                return e;
            }
        });
    }

    /**
     * maps every stream event through JSON.stringify
     * if its type is object
     * @returns {StreamDSL}
     */
    mapStringify(){

        return this.map(object => {

            if(typeof object !== "object"){
                return object;
            }

            return JSON.stringify(object);
        });
    }

    /**
     * maps every stream event's kafka message
     * right to its payload value
     * @returns {StreamDSL}
     */
    mapWrapKafkaPayload(){

       return this.map(message => {

            if(typeof message === "object" &&
                typeof message.value !== "undefined"){
                return message.value;
            }

            return message;
        });
    }

    /**
     * taps to the stream
     * counts messages and returns
     * callback once (when message count is reached)
     * with the current message at count
     * @param {number} count
     * @param {function} callback
     * @returns {StreamDSL}
     */
    atThroughput(count = 1, callback){

        let countState = 0;
        this.tap(message => {

            if(countState > count){
                return;
            }

            countState++;
            if(count === countState){
                callback(message);
            }
        });

        return this;
    }

    /**
     * * default kafka format stringify
     * {} -> {payload, time, type, id}
     * getId can be a function to read the id from the message
     * e.g. getId = message -> message.id
     * @param type
     * @param getId
     * @returns {StreamDSL}
     */
    mapToFormat(type = "unknown-publish", getId = null){

        this.map(message => {

            const id = getId ? getId(message) : uuid.v4();

            return {
                payload: message,
                time: (new Date()).toISOString(),
                type,
                id
            };
        });

        return this;
    }

    /**
     * default kafka format parser
     * {value: "{ payload: {} }" -> {}
     * @returns {StreamDSL}
     */
    mapFromFormat(){

        this.map(message => {

            if(typeof message === "object"){
                return message.payload;
            }

            try {
                const object = JSON.parse(message);
                if(typeof object === "object"){
                    return object.payload;
                }
            } catch(e){
                //empty
            }

            return message;
        });

        return this;
    }

    /**
    * maps elements into {time, value} objects
    * @param etl
    * @returns {StreamDSL}
    */
    timestamp(etl){

      	if(!etl){
        	this.stream$ = this.stream$.timestamp();
        	return this;
      	}

        this.stream$ = this.stream$.map(element => {
            return {
                time: etl(element),
                value: element
            };
        });

        return this;
    }

    /**
     * replace every element with the substitute value
     * @param substitute
     * @returns {StreamDSL}
     */
    constant(substitute){
        this.stream$ = this.stream$.constant(substitute);
        return this;
    }

    /**
     * mapping to incrementally accumulated results,
     * starting with the provided initial value.
     * @param eff
     * @param initial
     * @returns {StreamDSL}
     */
    scan(eff, initial){
        this.stream$ = this.stream$.scan(eff, initial);
        return this;
    }

    /**
     * slicing events from start ot end of index
     * @param start
     * @param end
     * @returns {StreamDSL}
     */
    slice(start, end){
        this.stream$ = this.stream$.slice(start, end);
        return this;
    }

    /**
     * contain events until predicate
     * returns false
     * m -> !!m
     * @param pred
     * @returns {StreamDSL}
     */
    takeWhile(pred){
        this.stream$ = this.stream$.takeWhile(pred);
        return this;
    }

    /**
     * contain events after predicate
     * returns false
     * @param pred
     * @returns {StreamDSL}
     */
    skipWhile(pred){
        this.stream$ = this.stream$.skipWhile(pred);
        return this;
    }

    /**
     * contain events until signal$ emits first event
     * signal$ must be a most stream instance
     * @param signal$
     * @returns {StreamDSL}
     */
    until(signal$){
        this.stream$ = this.stream$.until(signal$);
        return this;
    }

    /**
     * contain all events after signal$ emits first event
     * signal$ must be a most stream instance
     * @param signal$
     * @returns {StreamDSL}
     */
    since(signal$){
        this.stream$ = this.stream$.since(signal$);
        return this;
    }

    /**
     * reduce a stream to a single result
     * will return a promise
     * @param eff
     * @param initial
     * @returns Promise{*}
     */
    reduce(eff, initial){
        return this.stream$.reduce(eff, initial);
    }

    /**
     * runs reduce on a multicast stream
     * you probably would not want to use this in production
     * @param eff
     * @param initial
     * @param callback
     * @returns {StreamDSL}
     */
    chainReduce(eff, initial, callback){
        this.stream$ = this.stream$.multicast();
        this.stream$.reduce(eff, initial).then(r => {
            if(callback){
                callback(null, r);
            }
        }, e => {
            if(callback){
                callback(e);
            }
        });
        return this;
    }

    /**
     * drains the stream, equally to forEach
     * without iterator, returns a promise
     * @returns Promise{*}
     */
    drain(){
        return this.stream$.drain();
    }

    /**
     * limits rate events at most one per throttlePeriod
     * throttlePeriod = index count omit
     * @param throttlePeriod
     * @returns {StreamDSL}
     */
    throttle(throttlePeriod){
        this.stream$ = this.stream$.throttle(throttlePeriod);
        return this;
    }

    /**
     * delays every event in stream by given time
     * @param delayTime
     * @returns {StreamDSL}
     */
    delay(delayTime){
        this.stream$ = this.stream$.delay(delayTime);
        return this;
    }

    /**
     * wait for a burst of events and emit
     * only the last event
     * @param debounceTime
     * @returns {StreamDSL}
     */
    debounce(debounceTime){
        this.stream$ = this.stream$.debounce(debounceTime);
        return this;
    }

    /*
     *   #           #
     *  ##           ##
     * ### AGGREGATE ###
     *  ##           ##
     *   #           #
     */

    /**
     * maps into counts per key
     * requires events to have a present key/value field
     * @param key
     * @param countFieldName
     * @returns {StreamDSL}
     */
    countByKey(key = "key", countFieldName = "count"){
        const keyCount = new KeyCount(this.storage, key, countFieldName);
        this.asyncMap(keyCount.execute.bind(keyCount));
        return this;
    }

    /**
     * maps into sums per key
     * requires events to have a present key/value field
     * @param key
     * @param fieldName
     * @param sumField
     * @returns {StreamDSL}
     */
    sumByKey(key = "key", fieldName = "value", sumField = false){
        const sum = new Sum(this.storage, key, fieldName, sumField);
        this.asyncMap(sum.execute.bind(sum));
        return this;
    }

    /**
     * collects the smallest value
     * of the given field, will not alter
     * the events in the stream
     * use .getStorage().getMin() to get the
     * latest value which is stored
     * @param fieldName
     * @param minField
     * @returns {StreamDSL}
     */
    min(fieldName = "value", minField = "min"){
        const min = new Min(this.storage, fieldName, minField);
        this.asyncMap(min.execute.bind(min));
        return this;
    }

    /**
     * collects the greatest value
     * of the given field, will not alter
     * the events in the stream
     * use .getStorage().getMax() to get the
     * latest value which is stored
     * @param fieldName
     * @param maxField
     * @returns {StreamDSL}
     */
    max(fieldName = "value", maxField = "max"){
        const max = new Max(this.storage, fieldName, maxField);
        this.asyncMap(max.execute.bind(max));
        return this;
    }

    /*
     *   #           #
     *  ##           ##
     * ###   JOINS   ###
     *  ##           ##
     *   #           #
     */

    /**
     * use this as base of a higher-order stream
     * and merge all child streams into a new stream
     * @private
     */
    _join(){
        this.stream$ = most.join(this.stream$);
        return this;
    }

    /**
     * merge this stream with another, resulting a
     * stream with all elements from both streams
     * @param otherStream$
     */
    _merge(otherStream$){
        this.stream$ = most.merge(this.stream$, otherStream$);
        return this;
    }

    /**
     * merge this stream with another stream
     * by combining (zipping) every event from each stream
     * to a single new event on the new stream
     * combine = (e1, e2) -> e1 + e2
     * @param otherStream$
     * @param combine
     */
    _zip(otherStream$, combine){
        this.stream$ = this.stream$.zip(combine, otherStream$);
        return this;
    }

    /**
     * merge this stream with another stream
     * by combining (while awaiting) every event from each stream
     * combine = (e1, e2) -> e1 + e2
     * @param otherStream$
     * @param combine
     * @returns {StreamDSL}
     * @private
     */
    _combine(otherStream$, combine){
        this.stream$ = this.stream$.combine(combine, otherStream$);
        return this;
    }

    /**
     * merge this stream with another on behalf of
     * a sample stream
     * combine = (e1, e2) -> e1 + e2
     * @param sampleStream$
     * @param otherStream$
     * @param combine
     * @returns {StreamDSL}
     * @private
     */
    _sample(sampleStream$, otherStream$, combine){
        this.stream$ = sampleStream$.sample(combine, this.stream$, otherStream$);
        return this;
    }

    /*
     *   #           #
     *  ##           ##
     * ###  OUTPUT   ###
     *  ##           ##
     *   #           #
     */

    /**
     * define an output topic
     * when passed to KafkaStreams this will trigger
     * the stream$ result to be produced to the given topic name
     * if the instance is a clone, this function call will have to setup a kafka producer
     * returns a promise
     * @param {string} topic
     * @param {number} outputPartitionsCount
     * @param {string} produceType
     * @param {number} version
     * @param {number} compressionType
     * @param {function} producerErrorCallback
     * @returns {Promise.<boolean>}
     */
    to(topic, outputPartitionsCount = 1, produceType = "send", version = 1, compressionType = 0, producerErrorCallback = null){
        return new Promise(resolve => {

            if(this.produceAsTopic){
                throw new Error(".to() has already been called on this dsl instance.");
            }

            produceType = produceType || "";
            produceType = produceType.toLowerCase();
            const produceTypes = Object.keys(PRODUCE_TYPES).map(k => PRODUCE_TYPES[k]);
            if(produceTypes.indexOf(produceType) === -1){
                throw new Error(`produceType must be a supported types: ${produceTypes.join(", ")}.`);
            }

            this.produceAsTopic = true;
            this.outputTopicName = topic;
            this.outputPartitionsCount = outputPartitionsCount;
            this.produceType = produceType;
            this.produceVersion = version;
            this.produceCompressionType = compressionType;

            if(!this.isClone){
                return resolve(true);
            }

            //this instance is a clone, meaning that it has been created
            //as the result of a KStream or KTable merge
            //which requires the creation of a Producer for .to() to work first

            if(!this.kafka || !this.kafka.setupProducer){
                throw new Error("setting .to() on a cloned KStream requires a kafka client to injected during merge.");
            }

            this.kafka.setupProducer(this.outputTopicName, this.outputPartitionsCount,
                resolve, producerErrorCallback || NOOP);

            this.forEach(message => {

                let promise = null;
                switch(this.produceType){

                    case PRODUCE_TYPES.SEND:
                        promise = this.kafka.send(this.outputTopicName, message);
                        break;

                    case PRODUCE_TYPES.BUFFER:
                        promise = this.kafka.buffer(this.outputTopicName, null, message, compressionType);
                        break;

                    case PRODUCE_TYPES.BUFFER_FORMAT:
                        promise = this.kafka.bufferFormat(this.outputTopicName, null, message, version, compressionType);
                        break;
                }

                promise.catch(e => {
                    if(producerErrorCallback){
                        producerErrorCallback(e);
                    }
                });
            });

        });
    }
}

module.exports = StreamDSL;
