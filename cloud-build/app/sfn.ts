import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { IVpc, KeyPair, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
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
  DefinitionBody,
  IntegrationPattern,
  IStateMachine,
  JsonPath,
  StateMachine,
  TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  LambdaInvocationType,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface SFNImageBuilderProps {
  imageName: string;
  sourceImageId: string;
  vpc: IVpc;
  commands: string[];
}

export class SFNImageBuilder extends Construct {
  public readonly sfn: IStateMachine;

  private readonly logGroup: ILogGroup;

  constructor(scope: Construct, id: string, props: SFNImageBuilderProps) {
    super(scope, id);

    const secGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc: props.vpc,
      allowAllIpv6Outbound: true,
      allowAllOutbound: true,
    });

    const runnerPayload: { [key: string]: any } = {
      securityGroupId: secGroup.securityGroupId,
      commands: props.commands,
      imageId: props.sourceImageId,
    };

    const publicKey = this.node.tryGetContext("debug-ssh-public-key");
    if (publicKey) {
      const keyPair = new KeyPair(this, "KeyPair", {
        publicKeyMaterial: publicKey,
      });
      runnerPayload.keyName = keyPair.keyPairName;
      secGroup.addIngressRule(Peer.anyIpv4(), Port.SSH);
    }

    this.logGroup = new LogGroup(this, "LogGroup", {
      removalPolicy: RemovalPolicy.RETAIN,
      retention: RetentionDays.ONE_MONTH,
    });

    const runnerFn = this.createFunction("run_instance");
    // TODO: add permissions

    const errorHandler = LambdaInvoke.jsonPath(this, "errorHandler", {
      lambdaFunction: this.createFunction("on_error"),
    });

    const runnerStep = LambdaInvoke.jsonPath(this, "runnerStep", {
      lambdaFunction: runnerFn,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: TaskInput.fromObject({
        ...runnerPayload,
        token: JsonPath.taskToken,
        resourceId: JsonPath.stringAt("$.resourceId"),
      }),
    });
    runnerStep.addCatch(errorHandler, { resultPath: "$.errorPath" });

    this.sfn = new StateMachine(this, "SFN", {
      definitionBody: DefinitionBody.fromChainable(runnerStep),
    });
  }

  private createFunction(handler: string): IFunction {
    return new Function(this, `${handler}Handler`, {
      runtime: Runtime.PYTHON_3_13,
      code: Code.fromAsset(`${__dirname}/lambda`),
      handler: `index.${handler}`,
      timeout: Duration.minutes(1),
      logGroup: this.logGroup,
    });
  }
}
