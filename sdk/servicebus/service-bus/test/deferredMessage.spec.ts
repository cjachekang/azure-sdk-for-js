// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import chai from "chai";
const should = chai.should();
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
import { ServiceBusMessage } from "../src";
import { TestClientType, TestMessage } from "./utils/testUtils";
import { createServiceBusClientForTests, testPeekMsgsLength } from "./utils/testutils2";
import { Receiver } from "../src/receivers/receiver";
import { Sender } from "../src/sender";
import { ReceivedMessageWithLock } from "../src/serviceBusMessage";

describe("deferred messages", () => {
  let serviceBusClient: ReturnType<typeof createServiceBusClientForTests>;
  let sender: Sender;
  let receiver: Receiver<ReceivedMessageWithLock>;
  let deadLetterReceiver: Receiver<ReceivedMessageWithLock>;

  before(() => {
    serviceBusClient = createServiceBusClientForTests();
  });

  after(async () => {
    await serviceBusClient.test.after();
  });

  async function beforeEachTest(entityType: TestClientType): Promise<void> {
    const entityNames = await serviceBusClient.test.createTestEntities(entityType);

    receiver = await serviceBusClient.test.getPeekLockReceiver(entityNames);

    sender = serviceBusClient.test.addToCleanup(
      serviceBusClient.createSender(entityNames.queue ?? entityNames.topic!)
    );

    deadLetterReceiver = serviceBusClient.test.createDeadLetterReceiver(entityNames);
  }

  async function afterEachTest(): Promise<void> {
    await serviceBusClient.test.afterEach();
  }

  /**
   * Sends, defers, receives and then returns a test message
   * @param testMessage Test message to send, defer, receive and then return
   * @param passSequenceNumberInArray Boolean to indicate whether to pass the sequence number
   * as is or in an array to ensure both get code coverage
   */
  async function deferMessage(
    testMessage: ServiceBusMessage,
    passSequenceNumberInArray: boolean
  ): Promise<ReceivedMessageWithLock> {
    await sender.sendMessages(testMessage);
    const receivedMsgs = await receiver.receiveMessages(1);

    should.equal(receivedMsgs.length, 1, "Unexpected number of messages");
    should.equal(receivedMsgs[0].body, testMessage.body, "MessageBody is different than expected");
    should.equal(receivedMsgs[0].deliveryCount, 0, "DeliveryCount is different than expected");
    should.equal(
      receivedMsgs[0].messageId,
      testMessage.messageId,
      "MessageId is different than expected"
    );

    if (!receivedMsgs[0].sequenceNumber) {
      throw "Sequence Number can not be null";
    }
    const sequenceNumber = receivedMsgs[0].sequenceNumber;
    await receivedMsgs[0].defer();

    const [deferredMsg] = await receiver.receiveDeferredMessages(
      passSequenceNumberInArray ? [sequenceNumber] : sequenceNumber
    );
    if (!deferredMsg) {
      throw "No message received for sequence number";
    }
    should.equal(deferredMsg.body, testMessage.body, "MessageBody is different than expected");
    should.equal(
      deferredMsg.messageId,
      testMessage.messageId,
      "MessageId is different than expected"
    );
    should.equal(deferredMsg.deliveryCount, 1, "DeliveryCount is different than expected");

    return deferredMsg;
  }

  async function completeDeferredMessage(
    sequenceNumber: Long,
    expectedDeliverCount: number,
    testMessages: ServiceBusMessage
  ): Promise<void> {
    await testPeekMsgsLength(receiver, 1);

    const [deferredMsg] = await receiver.receiveDeferredMessages(sequenceNumber);
    if (!deferredMsg) {
      throw "No message received for sequence number";
    }

    should.equal(deferredMsg.body, testMessages.body, "MessageBody is different than expected");
    should.equal(
      deferredMsg.deliveryCount,
      expectedDeliverCount,
      "DeliveryCount is different than expected"
    );
    should.equal(
      deferredMsg.messageId,
      testMessages.messageId,
      "MessageId is different than expected"
    );

    await deferredMsg.complete();

    await testPeekMsgsLength(receiver, 0);
  }

  describe("Abandon/Defer/Deadletter deferred message", function(): void {
    afterEach(async () => {
      await afterEachTest();
    });

    async function testAbandon(useSessions?: boolean): Promise<void> {
      const testMessages = useSessions ? TestMessage.getSessionSample() : TestMessage.getSample();
      const deferredMsg = await deferMessage(testMessages, true);
      const sequenceNumber = deferredMsg.sequenceNumber;
      if (!sequenceNumber) {
        throw "Sequence Number can not be null";
      }
      await deferredMsg.abandon();
      await completeDeferredMessage(sequenceNumber, 2, testMessages);
    }

    it("Partitioned Queue: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueue);
      await testAbandon();
    });

    it("Partitioned Subscription: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscription);
      await testAbandon();
    });

    it("Partitioned Queue with Sessions: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueueWithSessions);
      await testAbandon(true);
    });

    it("Partitioned Subscription with Sessions: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscriptionWithSessions);
      await testAbandon(true);
    });

    it("Unpartitioned Queue: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueue);
      await testAbandon();
    });

    it("Unpartitioned Subscription: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscription);
      await testAbandon();
    });

    it("Unpartitioned Queue with Sessions:: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueueWithSessions);
      await testAbandon(true);
    });

    it("Unpartitioned Subscription with Sessions:: Abandoning a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscriptionWithSessions);
      await testAbandon(true);
    });

    async function testDefer(useSessions?: boolean): Promise<void> {
      const testMessages = useSessions ? TestMessage.getSessionSample() : TestMessage.getSample();
      const deferredMsg = await deferMessage(testMessages, false);
      const sequenceNumber = deferredMsg.sequenceNumber;
      if (!sequenceNumber) {
        throw "Sequence Number can not be null";
      }
      await deferredMsg.defer();
      await completeDeferredMessage(sequenceNumber, 2, testMessages);
    }

    it("Partitioned Queue: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueue);
      await testDefer();
    });

    it("Partitioned Subscription: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscription);
      await testDefer();
    });

    it("Partitioned Queue with Sessions: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueueWithSessions);
      await testDefer(true);
    });

    it("Partitioned Subscription with Sessions: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscriptionWithSessions);
      await testDefer(true);
    });

    it("Unpartitioned Queue: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueue);
      await testDefer();
    });

    it("Unpartitioned Subscription: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscription);
      await testDefer();
    });

    it("Unpartitioned Queue with Sessions: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueueWithSessions);
      await testDefer(true);
    });

    it("Unpartitioned Subscription with Sessions: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscriptionWithSessions);
      await testDefer(true);
    });

    async function testDeadletter(useSessions?: boolean): Promise<void> {
      const testMessages = useSessions ? TestMessage.getSessionSample() : TestMessage.getSample();
      const deferredMsg = await deferMessage(testMessages, true);

      await deferredMsg.deadLetter();

      await testPeekMsgsLength(receiver, 0);

      const deadLetterMsgs = await deadLetterReceiver.receiveMessages(1);

      should.equal(deadLetterMsgs.length, 1, "Unexpected number of messages");
      should.equal(
        deadLetterMsgs[0].body,
        testMessages.body,
        "MessageBody is different than expected"
      );
      should.equal(deadLetterMsgs[0].deliveryCount, 1, "DeliveryCount is different than expected");
      should.equal(
        deadLetterMsgs[0].messageId,
        testMessages.messageId,
        "MessageId is different than expected"
      );

      await deadLetterMsgs[0].complete();

      await testPeekMsgsLength(deadLetterReceiver, 0);
    }

    it("Partitioned Queue: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueue);
      await testDeadletter();
    });

    it("Partitioned Subscription: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscription);
      await testDeadletter();
    });

    it("Partitioned Queue with Sessions: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueueWithSessions);
      await testDeadletter(true);
    });

    it("Partitioned Subscription with Sessions: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscriptionWithSessions);
      await testDeadletter(true);
    });

    it("Unpartitioned Queue: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueue);
      await testDeadletter();
    });

    it("Unpartitioned Subscription: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscription);
      await testDeadletter();
    });

    it("Unpartitioned Queue with Sessions: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueueWithSessions);
      await testDeadletter(true);
    });

    it("Unpartitioned Subscription with Sessions: Deadlettering a deferred message moves it to dead letter queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscriptionWithSessions);
      await testDeadletter(true);
    });
  });

  describe("renewLock on a deferred message", function(): void {
    async function testRenewlockAndDefer(): Promise<void> {
      const testMessages = TestMessage.getSample();
      const deferredMsg = await deferMessage(testMessages, false);
      const sequenceNumber = deferredMsg.sequenceNumber;
      if (!sequenceNumber) {
        throw "Sequence Number can not be null";
      }
      const lockedUntilBeforeRenewlock = deferredMsg.lockedUntilUtc;
      const lockedUntilAfterRenewlock = await deferredMsg.renewLock();
      should.equal(
        lockedUntilAfterRenewlock > lockedUntilBeforeRenewlock!,
        true,
        "MessageLock did not get renewed!"
      );
      await deferredMsg.defer();
      await completeDeferredMessage(sequenceNumber, 2, testMessages);
    }

    it("Partitioned Queue: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedQueue);
      await testRenewlockAndDefer();
    });

    it("Partitioned Subscription: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.PartitionedSubscription);
      await testRenewlockAndDefer();
    });

    it("Unpartitioned Queue: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedQueue);
      await testRenewlockAndDefer();
    });

    it("Unpartitioned Subscription: Deferring a deferred message puts it back to the deferred queue.", async function(): Promise<
      void
    > {
      await beforeEachTest(TestClientType.UnpartitionedSubscription);
      await testRenewlockAndDefer();
    });
  });
});
