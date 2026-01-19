import { Duration } from "aws-cdk-lib";
import {
  InstanceProfile,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Function, FunctionOptions, IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { ILogGroup } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  IStateMachine,
  JsonPath,
  StateMachine,
  TaskInput,
  Timeout,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { pascalCase } from "change-case";
import { Construct } from "constructs";

export interface SFNImageBuilderProps {
  securityGroupId: string;
  keyName?: string;
  finalizerFn: IFunction;
  logGroup: ILogGroup;
  resourceTagKey: string;
}

export class SFNImageBuilder extends Construct {
  public readonly sfn: IStateMachine;

  private readonly props: SFNImageBuilderProps;

  constructor(scope: Construct, id: string, props: SFNImageBuilderProps) {
    super(scope, id);

    this.props = props;

    const instanceRole = new Role(this, "InstanceRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      inlinePolicies: {
        sendSFNToken: new PolicyDocument({
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

    const runnerStep = LambdaInvoke.jsonPath(this, "runnerStep", {
      stateName: "runInstance",
      lambdaFunction: this.createFunction("run_instance", {
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
      }),
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: TaskInput.fromObject({
        securityGroupId: props.securityGroupId,
        instanceProfileArn: instanceProfile.instanceProfileArn,
        keyName: props.keyName,
        taskToken: JsonPath.taskToken,
        cfn: JsonPath.objectAt("$.cfn"),
        props: JsonPath.objectAt("$.props"),
      }),
      taskTimeout: Timeout.duration(Duration.minutes(15)),
      resultPath: "$.instance",
    });

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

    const imageCreatorStep = LambdaInvoke.jsonPath(this, "imageCreatorStep", {
      stateName: "createImage",
      lambdaFunction: this.createFunction("create_image", {
        initialPolicy: [
          new PolicyStatement({
            actions: [
              "ec2:CreateImage",
              "ec2:CreateTags",
              "ec2:DescribeImages",
              "ec2:TerminateInstances",
            ],
            resources: ["*"],
          }),
        ],
      }),
      payloadResponseOnly: true,
      resultPath: "$.image",
    });

    stopperStep.next(
      Choice.jsonPath(scope, "instanceStateChoice", {
        stateName: "isInstanceStopped",
      })
        .when(Condition.booleanEquals("$.instance.stopped", true), imageCreatorStep)
        .otherwise(
          Wait.jsonPath(this, "waitInstanceStopped", {
            time: WaitTime.duration(Duration.seconds(5)),
          }).next(stopperStep),
        ),
    );
    runnerStep.next(stopperStep);

    const finalStep = LambdaInvoke.jsonPath(this, "finalStep", {
      stateName: "finalizer",
      lambdaFunction: props.finalizerFn,
      resultPath: JsonPath.DISCARD,
    });

    imageCreatorStep.next(
      Choice.jsonPath(this, "imageStateChoice", {
        stateName: "isImageAvailable",
      })
        .when(Condition.booleanEquals("$.image.available", true), finalStep)
        .otherwise(
          Wait.jsonPath(this, "waitImageAvailable", {
            time: WaitTime.duration(Duration.seconds(15)),
          }).next(imageCreatorStep),
        ),
    );

    [runnerStep, stopperStep, imageCreatorStep].forEach(s =>
      s.addCatch(finalStep, { resultPath: "$.error" }),
    );

    this.sfn = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(runnerStep),
    });
  }

  private createFunction(handler: string, opts?: FunctionOptions): IFunction {
    return new Function(this, pascalCase(handler), {
      runtime: Runtime.PYTHON_3_13,
      code: Code.fromAsset(`${__dirname}/lambda`),
      handler: `handler.${handler}`,
      timeout: Duration.minutes(3),
      logGroup: this.props.logGroup,
      ...opts,
      environment: {
        RESOURCE_TAG_KEY: this.props.resourceTagKey,
        ...(opts?.environment ?? {}),
      },
    });
  }
}
