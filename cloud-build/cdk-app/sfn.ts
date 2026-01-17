import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  KeyPair,
  Peer,
  Port,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import {
  InstanceProfile,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function,
  FunctionOptions,
  IFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  IStateMachine,
  JsonPath,
  Pass,
  StateMachine,
  TaskInput,
  Timeout,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface SFNImageBuilderProps {
  vpc: IVpc;
  imageName: string;
  sourceImageId: string;
  prepareScript: string[];
  instanceType?: InstanceType;
  rootVolSize?: number;
}

export class SFNImageBuilder extends Construct {
  public readonly sfn: IStateMachine;

  private readonly logGroup: ILogGroup;

  constructor(scope: Construct, id: string, props: SFNImageBuilderProps) {
    super(scope, id);

    this.logGroup = new LogGroup(this, "LogGroup", {
      removalPolicy: RemovalPolicy.RETAIN,
      retention: RetentionDays.ONE_MONTH,
    });

    const secGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc: props.vpc,
      allowAllIpv6Outbound: true,
      allowAllOutbound: true,
    });

    const instanceRole = new Role(this, "InstanceRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      inlinePolicies: {
        sfnToken: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    const instanceProfile = new InstanceProfile(this, "InstanceProfile", {
      role: instanceRole,
    });

    const errorHandler = LambdaInvoke.jsonPath(this, "errorHandler", {
      lambdaFunction: this.createFunction("on_error"),
    });

    const runnerPayload: { [key: string]: any } = {
      securityGroupId: secGroup.securityGroupId,
      sourceImageId: props.sourceImageId,
      imageName: props.imageName,
      prepareScript: props.prepareScript,
      rootVolSize: props.rootVolSize ?? 10,
      instanceType: (
        props.instanceType ??
        InstanceType.of(InstanceClass.T3, InstanceSize.SMALL)
      ).toString(),
      instanceProfileArn: instanceProfile.instanceProfileArn,
    };

    const publicKey = this.node.tryGetContext("debug-ssh-public-key");
    if (publicKey) {
      runnerPayload.keyName = new KeyPair(this, "KeyPair", {
        publicKeyMaterial: publicKey,
      }).keyPairName;
      secGroup.addIngressRule(Peer.anyIpv4(), Port.SSH);
    }

    const runnerFn = this.createFunction("run_instance", {
      initialPolicy: [
        new PolicyStatement({
          actions: ["ec2:RunInstances", "ec2:CreateTags"],
          resources: ["*"],
        }),
        new PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [instanceRole.roleArn],
        }),
      ],
    });

    const runnerStep = LambdaInvoke.jsonPath(this, "runnerStep", {
      stateName: "runInstance",
      lambdaFunction: runnerFn,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: TaskInput.fromObject({
        ...runnerPayload,
        taskToken: JsonPath.taskToken,
        resourceId: JsonPath.stringAt("$.resourceId"),
      }),
      taskTimeout: Timeout.duration(Duration.minutes(15)),
      resultPath: "$.instance",
    });
    runnerStep.addCatch(errorHandler, { resultPath: "$.errorPath" });

    const stopperStep = LambdaInvoke.jsonPath(this, "stopperStep", {
      stateName: "stopInstance",
      lambdaFunction: this.createFunction("stop_instance", {
        initialPolicy: [
          new PolicyStatement({
            actions: ["ec2:DescribeInstances", "ec2:StopInstances"],
            resources: ["*"],
          }),
        ],
      }),
      payload: TaskInput.fromObject({ id: JsonPath.stringAt("$.instance.id") }),
      payloadResponseOnly: true,
      resultPath: "$.instance.stopped",
    });

    stopperStep.addCatch(errorHandler);
    stopperStep.next(
      Choice.jsonPath(scope, "instanceStateChoice", {
        stateName: "isInstanceStopped",
      })
        .when(
          Condition.booleanEquals("$.instance.stopped", true),
          Pass.jsonPath(this, "finalStep"),
        )
        .otherwise(
          Wait.jsonPath(this, "waitInstanceStopped", {
            time: WaitTime.duration(Duration.seconds(5)),
          }).next(stopperStep),
        ),
    );
    runnerStep.next(stopperStep);

    this.sfn = new StateMachine(this, "SFN", {
      definitionBody: DefinitionBody.fromChainable(runnerStep),
    });
  }

  private createFunction(handler: string, opts?: FunctionOptions): IFunction {
    return new Function(this, `${handler}Handler`, {
      runtime: Runtime.PYTHON_3_13,
      code: Code.fromAsset(`${__dirname}/lambda`),
      handler: `index.${handler}`,
      timeout: Duration.minutes(1),
      logGroup: this.logGroup,
      ...opts,
    });
  }
}
